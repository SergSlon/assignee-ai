/**
 * Compound-pattern suppression link — decides when a best-practice rule
 * should be skipped because the enclosing compound pattern already
 * satisfies the intent at the pattern level (e.g. message-processing
 * provisions a dedicated DLQ, so the per-queue RedrivePolicy rule should
 * not fire).
 *
 * Split from evaluate.ts (W6d F3). Adding a new suppression rule = new
 * entry here, no changes to the rule-runner.
 */

import type { BestPractice } from "../types.js";
import type { EvalContext } from "./context-builder.js";

/** Pattern ID constant for message-processing — must match @assignee/core PatternId.MESSAGE_PROCESSING */
const PATTERN_MESSAGE_PROCESSING = "message-processing" as const;

/**
 * Compound patterns may satisfy certain best practices at the pattern level
 * (e.g., a DLQ is a separate resource in the pattern, not a RedrivePolicy on the queue).
 * Skip these checks when the pattern guarantees the intent is met.
 */
export function shouldSkipForPattern(
  bp: BestPractice,
  context: EvalContext,
): boolean {
  // message-processing pattern includes a dedicated DLQ — skip "needs RedrivePolicy" for SQS queues
  if (
    context.patternId === PATTERN_MESSAGE_PROCESSING &&
    bp.id === "BP-SQS-002" // DLQ check
  ) {
    return true;
  }

  // SSE-SQS (SqsManagedSseEnabled) satisfies encryption — skip KMS-specific check
  if (
    bp.id === "BP-SQS-003" &&
    context.desiredState["SqsManagedSseEnabled"] === true
  ) {
    return true;
  }

  return false;
}
