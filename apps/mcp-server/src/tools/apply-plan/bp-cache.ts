/**
 * Best-practice rule re-evaluation for apply_plan.
 *
 * Story 41.4: BP rules are re-evaluated against the checkpoint's
 * desiredState before provisioning so rules added or modified after
 * the original plan was generated still block the apply.
 *
 * Story 50-4 (D): the previous module-level cache violated the
 * "BP re-eval on every apply" contract — rules edited between applies
 * in the same MCP process lifetime were silently ignored. Now BP YAML
 * is loaded on every call (CLI already does this per apply; cost is
 * negligible because `loadBestPractices()` reads a handful of small
 * YAML files under `packages/best-practices/rules/`).
 *
 * `_resetBPCache` is retained as a no-op so existing test imports
 * keep compiling; it will be removed when tests are updated to drop
 * the stale reset call.
 */

import {
  loadBestPractices,
  evaluateTriggers,
  type BPFinding,
  type EvalContext,
} from "@assignee/best-practices";

/** Result of BP re-evaluation. */
export interface BPEvaluationResult {
  /** Non-blocking findings to attach to the apply-time state. */
  findings?: BPFinding[];
  /** Blocking findings. Non-empty means apply must be aborted. */
  blocking: BPFinding[];
}

/**
 * Re-evaluates BP rules against a checkpoint's context. Reloads the
 * BP rule pack from disk on every call so edits between applies are
 * picked up immediately (Story 50-4).
 */
export function evaluateCheckpointBPs(
  context: EvalContext,
): BPEvaluationResult {
  const findings = evaluateTriggers(context, loadBestPractices());
  const blocking = findings.filter((f) => f.blocking);
  return {
    findings: findings.length > 0 ? findings : undefined,
    blocking,
  };
}

/**
 * Retained no-op for backwards compatibility with tests that reset
 * the (now-removed) cache between cases. New code should not call
 * this — BP rules are reloaded on every apply.
 */
export function _resetBPCache(): void {
  // no-op: cache removed in Story 50-4.
}
