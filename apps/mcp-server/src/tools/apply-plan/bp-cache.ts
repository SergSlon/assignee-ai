/**
 * Best-practice rule cache + re-evaluation for apply_plan.
 *
 * Story 41.4: BP rules are re-evaluated against the checkpoint's
 * desiredState before provisioning so rules added or modified after
 * the original plan was generated still block the apply.
 *
 * The cache is module-level and explicit-reset only — the MCP server
 * is long-lived so loading rules once per process is cheap and
 * correct.
 */

import {
  loadBestPractices,
  evaluateTriggers,
  type BestPractice,
  type BPFinding,
  type EvalContext,
} from "@assignee/best-practices";

let cachedPractices: BestPractice[] | undefined;

/** Lazy loader — reads from disk on first call, serves from memory after. */
export function loadCachedPractices(): BestPractice[] {
  if (cachedPractices === undefined) {
    cachedPractices = loadBestPractices();
  }
  return cachedPractices;
}

/** Exported for testing — resets the BP cache. */
export function _resetBPCache(): void {
  cachedPractices = undefined;
}

/** Result of BP re-evaluation. */
export interface BPEvaluationResult {
  /** Non-blocking findings to attach to the apply-time state. */
  findings?: BPFinding[];
  /** Blocking findings. Non-empty means apply must be aborted. */
  blocking: BPFinding[];
}

/**
 * Re-evaluates BP rules against a checkpoint's context. Splits
 * findings into blocking vs. non-blocking so the caller can decide
 * whether to abort before invoking the graph.
 */
export function evaluateCheckpointBPs(
  context: EvalContext,
): BPEvaluationResult {
  const findings = evaluateTriggers(context, loadCachedPractices());
  const blocking = findings.filter((f) => f.blocking);
  return {
    findings: findings.length > 0 ? findings : undefined,
    blocking,
  };
}
