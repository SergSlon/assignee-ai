/**
 * Post–Phase 1 outcome dispatcher.
 *
 * Classifies the Phase 1 terminal state and routes to the appropriate
 * branch handler. Each terminal status has its own focused module under
 * `phase1-gate/` so clarifier-retry, fix-and-continue, catch-all, and
 * budget-check logic can each be read and tested in isolation
 * (Story 58-it1-02 split).
 */

import * as clack from "@clack/prompts";
import { ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../../services/graph.js";
import type { Phase1Context, Phase1Deps } from "./phase1-planner.js";
import { logApplyComplete } from "./phase1-gate/log-helpers.js";
import {
  handleFailureClass,
  isFailureStatus,
} from "./phase1-gate/failure-class.js";
import { handleBpBlocked } from "./phase1-gate/bp-blocked.js";
import {
  handleUnexpectedStatus,
  runBudgetGuard,
} from "./phase1-gate/post-check.js";
import type { Phase1GateResult } from "./phase1-gate/types.js";

export type { Phase1GateResult } from "./phase1-gate/types.js";
export { buildContinueInvocation } from "./phase1-gate/invocation-builder.js";

/**
 * Evaluate Phase 1 state — early exit for cancelled/failed/blocked, or
 * re-invoke graph on successful interactive fix-and-continue, or signal
 * the caller to proceed to Phase 2.
 */
export async function handlePhase1Outcome(
  ctx: Phase1Context,
  deps: Phase1Deps,
  initialState: AgentState,
  effectiveIntent: string,
): Promise<Phase1GateResult> {
  let phase1State = initialState;

  if (phase1State.executionStatus === ExecutionStatus.CANCELLED) {
    logApplyComplete(ctx, ExecutionStatus.CANCELLED);
    return { kind: "done", result: { success: true } };
  }

  // Story feature-query-intent-classifier: query intents complete inside
  // the graph (query_handler → result_formatter → END). By the time
  // phase1State returns, the output is already printed. Return success
  // without attempting Phase 2 provisioning (reads don't need HITL / writes).
  if (phase1State.executionStatus === ExecutionStatus.QUERY_INTENT) {
    // MED 3: warn when the user passed --source with a query intent.
    // --source only makes sense for creation (static-website pattern). It is
    // silently ignored for reads; we surface a warning so the user understands.
    if (deps.resolvedSourceDir) {
      clack.log.warn(
        "--source is ignored for query intents. " +
          "Use --source only when creating or updating resources.",
      );
    }
    logApplyComplete(ctx, ExecutionStatus.QUERY_INTENT);
    return { kind: "done", result: { success: true } };
  }

  if (isFailureStatus(phase1State.executionStatus)) {
    const { next, result } = await handleFailureClass(ctx, deps, phase1State);
    if (result) return result;
    phase1State = next;
  }

  if (
    phase1State.executionStatus === ExecutionStatus.PENDING &&
    phase1State.preflightPassed === false
  ) {
    const { next, result } = await handleBpBlocked(
      ctx,
      deps,
      phase1State,
      effectiveIntent,
    );
    if (result) return result;
    phase1State = next;
  }

  if (
    phase1State.executionStatus !== ExecutionStatus.IN_PROGRESS &&
    phase1State.executionStatus !== ExecutionStatus.PENDING
  ) {
    return handleUnexpectedStatus(ctx, phase1State);
  }

  const budgetResult = runBudgetGuard(phase1State, deps);
  if (budgetResult) return budgetResult;

  return { kind: "continue", phase1State };
}
