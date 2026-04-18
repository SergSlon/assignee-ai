/**
 * apply_plan MCP tool handler — orchestrates preflight, checkpoint
 * load, concurrency guard, BP re-evaluation, and graph execution.
 *
 * Safety mechanism: requires `confirmed: true` to proceed — prevents
 * accidental provisioning by AI agents. The agent must present the
 * plan to the user and get explicit approval first.
 *
 * Story 50-5 H-3: every successful and failing apply is mirrored to
 * the persistent audit-log JSONL in addition to the existing stderr
 * `mcpLog` stream. Every audit write routes through `logApplyAudit`
 * (see ./audit.ts) so the six-field envelope cannot drift between
 * call-sites.
 *
 * Story 54-it1-08 refactor: the pre-refactor inner arrow was 145 LOC
 * with four duplicated 6-field `auditLog()` envelopes and nested
 * try/catch blocks. Phase helpers moved into ./handler-steps.ts
 * following the StepResult pattern (see utils/step-result.ts and
 * destroy-resource/handler-steps.ts). Audit writes consolidated into
 * ./audit.ts so the envelope shape is defined exactly once.
 *
 * @see Epic 20, Story 20.3, ADR-008, Story 50-5, Story 54-it1-08
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redactSensitive } from "@assignee/core";
import type { GraphContext } from "../../services/graph-init.js";
import { mcpLogWarn } from "../../utils/structured-log.js";
import { releaseApply } from "./active-applies.js";
import { applyPlanParams } from "./params.js";
import { type ToolEnvelope } from "./result-envelope.js";
import {
  executeAndAudit,
  guardConcurrency,
  loadAndValidateCheckpoint,
  reevaluateBestPractices,
  runPreflightGuards,
} from "./handler-steps.js";

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
    //
    // L5-H2 hardening: route the textSnippet through redactSensitive so
    // any ARN / 12-digit account ID that happens to be in the
    // unparseable blob cannot leak to stderr log aggregators. Uses the
    // canonical allowlist-shaped redactor from @assignee/core per
    // feedback_redaction_allowlist_not_denylist memory — no local
    // denylist regex is introduced.
    mcpLogWarn(
      "apply-plan/handler",
      "extract-audit-identifier-parse-fail",
      {
        error: err instanceof Error ? err.message : String(err),
        textSnippet: redactSensitive(text.slice(0, 200)),
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
      const preflight = runPreflightGuards(confirmed, ctx, checkpointPath);
      if (preflight.kind === "done") return preflight.response;

      const loaded = await loadAndValidateCheckpoint(checkpointPath);
      if (loaded.kind === "done") return loaded.response;
      const checkpoint = loaded.context;

      const concurrency = await guardConcurrency(checkpoint, checkpointPath);
      if (concurrency.kind === "done") return concurrency.response;

      try {
        const bp = await reevaluateBestPractices(checkpoint, checkpointPath);
        if (bp.kind === "done") return bp.response;

        // ctx is narrowed by runPreflightGuards above, but the type guard
        // doesn't propagate through the closure so assert non-null here.
        return await executeAndAudit(
          ctx!,
          checkpoint,
          checkpointPath,
          bp.context,
          extractAuditIdentifier,
        );
      } finally {
        releaseApply(checkpointPath);
      }
    },
  );
}
