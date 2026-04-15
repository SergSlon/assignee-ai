/**
 * apply_plan MCP tool handler — orchestrates preflight, checkpoint
 * load, BP re-evaluation, concurrency guard, and graph execution.
 *
 * Safety mechanism: requires `confirmed: true` to proceed — prevents
 * accidental provisioning by AI agents. The agent must present the
 * plan to the user and get explicit approval first.
 *
 * @see Epic 20, Story 20.3, ADR-008
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CheckpointError } from "@assignee/core";
import type { EvalContext } from "@assignee/best-practices";
import type { GraphContext } from "../../services/graph-init.js";
import { loadCheckpointFromPath } from "../../services/checkpoint.js";
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
import { errorEnvelope } from "./result-envelope.js";

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
        return errorEnvelope({
          message:
            err instanceof CheckpointError
              ? err.message
              : `Checkpoint file not found: ${checkpointPath}. Run plan_resource first.`,
        });
      }

      // ── Concurrency guard: one apply per checkpoint at a time ──────────
      if (isApplyActive(checkpointPath)) {
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
          return errorEnvelope({
            message: `BP evaluation failed — cannot verify security compliance. ${bpError instanceof Error ? bpError.message : String(bpError)}`,
            hint: "Check that best-practice rules are accessible. Run plan_resource to generate a fresh plan.",
          });
        }

        // ── Execute the graph from the checkpoint ────────────────────────
        // ctx is narrowed by checkGraphContext above; the type-guard
        // doesn't propagate through the closure so assert non-null here.
        return await runGraphFromCheckpoint({
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
      } finally {
        releaseApply(checkpointPath);
      }
    },
  );
}
