/**
 * result_formatter node — final rendering gate.
 *
 * Handles all terminal outcomes: SUCCESS, FAILED, CANCELLED, and plan-mode
 * preview. Emits the per-command TOKEN_USAGE_SUMMARY row, then dispatches
 * to the appropriate formatter.
 *
 * SOLID refactor (Wave 6b F5b): this entrypoint is now a thin orchestrator.
 * Actual rendering lives under `./result-formatter/`:
 *   - arn-display.ts                  — buildResourceArn-based display helpers
 *   - formatters/apply-single.ts      — SUCCESS (single resource)
 *   - formatters/apply-compound.ts    — SUCCESS (compound pattern)
 *   - formatters/error.ts             — FAILED / POLICY_BLOCKED / UNSUPPORTED
 *   - formatters/plan.ts              — PENDING / plan-mode preview
 *   - formatters/static-site-upload.ts — Story 37.4 post-provision hooks
 *   - registry.ts                     — mode-and-shape → formatter dispatcher
 *
 * @see Story 2-4, Story 9-6, Story 18-3
 */

import type { StructuredTool } from "@langchain/core/tools";
import type { AgentState } from "../graph-state.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import { emitTokenUsageSummary } from "../../utils/token-usage.js";
import { dispatchFormatter } from "./result-formatter/registry.js";

export async function resultFormatterNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESULT_FORMATTED,
    extras: { executionStatus: state.executionStatus },
  });

  // Wave 12 P0 — one TOKEN_USAGE_SUMMARY entry per command, regardless of
  // execution outcome. Every command produces exactly one summary row so
  // downstream analysis can grep with `action=token_usage_summary`.
  // Failures still accumulated tokens before they failed; those costs are real.
  emitTokenUsageSummary(state.runId);

  return dispatchFormatter(state, tools);
}
