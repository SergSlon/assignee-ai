/**
 * FAILED / UNSUPPORTED_RESOURCE / POLICY_BLOCKED branch handler for
 * phase1-gate. Runs the Story 52-1 clarifier retry (if eligible),
 * re-checks the resulting state, and either exits with a rendered error
 * or hands `null` back so the outer dispatcher falls through.
 */

import { ExecutionStatus, type ExecutionStatusType } from "@assignee/core";
import type { AgentState } from "../../../services/graph.js";
import { renderError } from "../../../utils/display.js";
import { SUPPORTED_TYPES_HINT } from "../../../config/constants.js";
import { askClarifyingQuestion } from "../../../services/clarifier.js";
import {
  buildFreshPlanState,
  type Phase1Context,
  type Phase1Deps,
} from "../phase1-planner.js";
import { logApplyComplete } from "./log-helpers.js";
import type { Phase1GateResult } from "./types.js";

const FAILURE_STATUSES: readonly ExecutionStatusType[] = [
  ExecutionStatus.FAILED,
  ExecutionStatus.UNSUPPORTED_RESOURCE,
  ExecutionStatus.POLICY_BLOCKED,
];

export function isFailureStatus(
  status: ExecutionStatusType | undefined,
): boolean {
  return status !== undefined && FAILURE_STATUSES.includes(status);
}

/**
 * Story 52-1: offer ONE clarifying rephrase when Phase 1 failed on
 * intent-ambiguity. Bypassed silently for `--yes` / `--quick` / non-TTY
 * and for POLICY_BLOCKED (policy is not an intent problem). Returns the
 * state AFTER an optional re-invoke; identical to input if no retry.
 */
async function maybeRetryWithClarifier(
  ctx: Phase1Context,
  deps: Phase1Deps,
  phase1State: AgentState,
): Promise<AgentState> {
  if (phase1State.executionStatus === ExecutionStatus.POLICY_BLOCKED) {
    return phase1State;
  }
  const rephrased = await askClarifyingQuestion({
    state: phase1State,
    autoApprove: deps.opts.yes === true,
    quick: deps.opts.quick === true,
  });
  if (!rephrased) return phase1State;

  ctx.intent = rephrased;
  return (await ctx.graph.invoke(
    buildFreshPlanState(ctx, deps) as Parameters<typeof ctx.graph.invoke>[0],
    deps.graphConfig as Parameters<typeof ctx.graph.invoke>[1],
  )) as AgentState;
}

/** Render the user-facing error for a terminal Phase-1 failure. */
function renderFailureError(phase1State: AgentState): void {
  const defaultHint =
    phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
      ? SUPPORTED_TYPES_HINT
      : "Try rephrasing your intent, or run `assignee --verbose apply <intent>` to see which node returned FAILED. Common causes: Bedrock region mismatch, missing credentials, or an intent the LLM could not map to a supported type.";
  renderError(
    phase1State.errorMessage ??
      "Apply could not start — the planning phase did not produce a valid plan.",
    defaultHint,
  );
}

/**
 * Handle FAILED / UNSUPPORTED_RESOURCE / POLICY_BLOCKED. Runs the
 * clarifier retry (if eligible); re-checks; either exits with a rendered
 * error or returns `null` for the caller to fall through on a clarifier
 * success.
 */
export async function handleFailureClass(
  ctx: Phase1Context,
  deps: Phase1Deps,
  phase1State: AgentState,
): Promise<{ next: AgentState; result: Phase1GateResult | null }> {
  const afterRetry = await maybeRetryWithClarifier(ctx, deps, phase1State);
  if (!isFailureStatus(afterRetry.executionStatus)) {
    return { next: afterRetry, result: null };
  }
  logApplyComplete(ctx, afterRetry.executionStatus as string);
  renderFailureError(afterRetry);
  return {
    next: afterRetry,
    result: { kind: "done", result: { success: false } },
  };
}
