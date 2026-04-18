/**
 * apply_plan MCP tool handler — orchestrates preflight, checkpoint
 * load, BP re-evaluation, concurrency guard, and graph execution.
 *
 * Safety mechanism: requires `confirmed: true` to proceed — prevents
 * accidental provisioning by AI agents. The agent must present the
 * plan to the user and get explicit approval first.
 *
 * Story 50-5 H-3: every successful and failing apply is mirrored to
 * the persistent audit-log JSONL in addition to the existing stderr
 * `mcpLog` stream.
 *
 * @see Epic 20, Story 20.3, ADR-008, Story 50-5
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CheckpointError } from "@assignee/core";
import type { EvalContext } from "@assignee/best-practices";
import type { GraphContext } from "../../services/graph-init.js";
import { loadCheckpointFromPath } from "../../services/checkpoint.js";
import { auditLog } from "../../utils/audit-log.js";
import { mcpLogWarn } from "../../utils/structured-log.js";
import {
  isApplyActive,
  markApplyActive,
  releaseApply,
} from "./active-applies.js";
import { evaluateCheckpointBPs } from "./bp-cache.js";
import { runGraphFromCheckpoint } from "./graph-executor.js";
import { applyPlanParams } from "./params.js";
import {
  checkCheckpointPath,
  checkConfirmedGate,
  checkGraphContext,
} from "./preflight.js";
import { errorEnvelope, type ToolEnvelope } from "./result-envelope.js";

/**
 * Extracts an audit-safe identifier from an apply_plan result envelope.
 * Prefers the ARN from the graph's successful output; falls back to
 * the empty string so the JSONL schema remains stable.
 *
 * Exported for unit testing of the parse-failure warning path
 * (Wave L2 added structured-log surfacing; kept non-exported helper
 * would otherwise block coverage on the catch branch).
 */
export function extractAuditIdentifier(envelope: ToolEnvelope): string {
  const text = envelope.content?.[0]?.text;
  if (typeof text !== "string") return "";
  try {
    const body = JSON.parse(text) as { resourceArn?: unknown };
    if (typeof body.resourceArn === "string") return body.resourceArn;
  } catch (err) {
    // Non-JSON envelope (shouldn't happen under the documented contract).
    // Emit a structured warning so the parse failure is visible in
    // stderr tail / log aggregators; preserve the empty-string fallback
    // so the JSONL audit schema stays stable.
    mcpLogWarn(
      "apply-plan/handler",
      "extract-audit-identifier-parse-fail",
      {
        error: err instanceof Error ? err.message : String(err),
        textSnippet: text.slice(0, 200),
      },
      "Failed to parse apply_plan envelope text as JSON; audit identifier will be empty.",
    );
  }
  return "";
}

export function registerApplyPlan(server: McpServer, ctx?: GraphContext): void {
  server.tool(
    "apply_plan",
    "Apply a previously generated infrastructure plan. REQUIRES confirmed: true as a safety mechanism — the AI agent must explicitly confirm before provisioning.",
    applyPlanParams,
    async ({ checkpointPath, confirmed }) => {
      // ── Cheap preflight guards ────────────────────────────────────────
      const confirmedError = checkConfirmedGate(confirmed);
      if (confirmedError) return confirmedError;

      const ctxError = checkGraphContext(ctx);
      if (ctxError) return ctxError;

      const pathError = checkCheckpointPath(checkpointPath);
      if (pathError) return pathError;

      // ── Load and validate checkpoint ──────────────────────────────────
      let checkpoint;
      try {
        checkpoint = await loadCheckpointFromPath(checkpointPath);
      } catch (err) {
        const message =
          err instanceof CheckpointError
            ? err.message
            : `Checkpoint file not found: ${checkpointPath}. Run plan_resource first.`;
        // Story 50-5 H-3: audit the failed load attempt. runId +
        // resourceType may not yet be known here; use "" sentinel.
        await auditLog({
          tool: "apply_plan",
          runId: "",
          resourceType: "",
          identifier: checkpointPath,
          success: false,
          errorClass:
            err instanceof CheckpointError ? "CheckpointError" : "UnknownError",
        });
        return errorEnvelope({ message });
      }

      // ── Concurrency guard: one apply per checkpoint at a time ──────────
      if (isApplyActive(checkpointPath)) {
        await auditLog({
          tool: "apply_plan",
          runId: checkpoint.runId,
          resourceType: checkpoint.resourceType,
          identifier: checkpointPath,
          success: false,
          errorClass: "ApplyAlreadyActive",
        });
        return errorEnvelope({
          message:
            "This plan is already being applied. Wait for the current operation to complete.",
        });
      }
      markApplyActive(checkpointPath);

      try {
        // ── Story 41.4: BP re-evaluation before provisioning ────────────
        // Catches rules added or modified after the original plan was
        // generated. MCP always enforces BPs — fail closed on error.
        let bpFindings;
        let preflightPassed = checkpoint.preflightPassed;

        try {
          const evalContext: EvalContext = {
            resourceType: checkpoint.resourceType,
            desiredState: checkpoint.desiredState,
            userIntent: checkpoint.userIntent,
            patternId: checkpoint.resourcePatternId ?? undefined,
          };
          const result = evaluateCheckpointBPs(evalContext);

          if (result.blocking.length > 0) {
            await auditLog({
              tool: "apply_plan",
              runId: checkpoint.runId,
              resourceType: checkpoint.resourceType,
              identifier: checkpointPath,
              success: false,
              errorClass: "BpBlocked",
            });
            return errorEnvelope({
              message: `BP re-evaluation blocked apply: ${result.blocking.length} blocking finding(s) detected since the plan was generated.`,
              blockingFindings: result.blocking.map((f) => ({
                practiceId: f.practiceId,
                title: f.title,
                severity: f.severity,
                message: f.message,
                remediation: f.remediation,
                consequence: f.consequence,
              })),
              hint: "Run plan_resource again to generate a new plan that satisfies current best practices.",
            });
          }
          bpFindings = result.findings;
        } catch (bpError: unknown) {
          // BP evaluation failure must be fail-closed in enforce mode —
          // block provisioning rather than silently skipping all rules.
          preflightPassed = false;
          await auditLog({
            tool: "apply_plan",
            runId: checkpoint.runId,
            resourceType: checkpoint.resourceType,
            identifier: checkpointPath,
            success: false,
            errorClass: "BpEvaluationError",
          });
          return errorEnvelope({
            message: `BP evaluation failed — cannot verify security compliance. ${bpError instanceof Error ? bpError.message : String(bpError)}`,
            hint: "Check that best-practice rules are accessible. Run plan_resource to generate a fresh plan.",
          });
        }

        // ── Execute the graph from the checkpoint ────────────────────────
        // ctx is narrowed by checkGraphContext above; the type-guard
        // doesn't propagate through the closure so assert non-null here.
        const envelope = await runGraphFromCheckpoint({
          ctx: ctx!,
          checkpoint: {
            runId: checkpoint.runId,
            userIntent: checkpoint.userIntent,
            resourceType: checkpoint.resourceType,
            desiredState: checkpoint.desiredState,
            estimatedMonthlyCost: checkpoint.estimatedMonthlyCost,
            preflightPassed: checkpoint.preflightPassed,
            elicitedOptions: checkpoint.elicitedOptions,
            resourceQueue: checkpoint.resourceQueue,
          },
          bpFindings,
          preflightPassed,
        });

        // Story 50-5 H-3: mirror the outcome to the persistent audit log.
        const succeeded = envelope.isError !== true;
        await auditLog({
          tool: "apply_plan",
          runId: checkpoint.runId,
          resourceType: checkpoint.resourceType,
          identifier: succeeded
            ? extractAuditIdentifier(envelope) || checkpointPath
            : checkpointPath,
          success: succeeded,
          errorClass: succeeded ? "" : "GraphExecutionError",
        });
        return envelope;
      } finally {
        releaseApply(checkpointPath);
      }
    },
  );
}
