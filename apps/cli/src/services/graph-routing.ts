/**
 * Conditional routing functions for the LangGraph agent graph.
 * Separated from graph.ts for clarity and testability.
 */

import { END } from "@langchain/langgraph";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import { GraphNode } from "../constants/graph.js";
import type { AgentState } from "./graph-state.js";

/** Routes after START: checkpoint resumed → human_approval (skip Phase 1), else → intent_parser. */
export function routeCheckpointEntry(
  state: AgentState,
): typeof GraphNode.INTENT_PARSER | typeof GraphNode.HUMAN_APPROVAL {
  // Terminal states must never reach HUMAN_APPROVAL — short-circuit to INTENT_PARSER
  // which will fall through to result_formatter.
  if (
    state.executionStatus === ExecutionStatus.FAILED ||
    state.executionStatus === ExecutionStatus.CANCELLED ||
    state.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE ||
    state.executionStatus === ExecutionStatus.POLICY_BLOCKED
  ) {
    return GraphNode.INTENT_PARSER;
  }
  if (state.checkpointResumed && state.desiredState) {
    return GraphNode.HUMAN_APPROVAL;
  }
  return GraphNode.INTENT_PARSER;
}

/** Routes after preflight_guard: plan → result, apply → approval or provisioner.
 *  Safety: a checkpoint-resumed run whose state is FAILED/CANCELLED must never
 *  reach HUMAN_APPROVAL — always short-circuit to RESULT_FORMATTER. */
export function routePreflightGuard(
  state: AgentState,
):
  | typeof GraphNode.HUMAN_APPROVAL
  | typeof GraphNode.RESULT_FORMATTER
  | typeof GraphNode.RESOURCE_PROVISIONER {
  // Guard: terminal execution states always go straight to result formatting,
  // even if preflightPassed is true (e.g., checkpoint-resumed failed run).
  if (
    state.executionStatus === ExecutionStatus.FAILED ||
    state.executionStatus === ExecutionStatus.CANCELLED ||
    state.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE ||
    state.executionStatus === ExecutionStatus.POLICY_BLOCKED
  ) {
    return GraphNode.RESULT_FORMATTER;
  }
  if (state.executionMode === ExecutionMode.PLAN || !state.preflightPassed) {
    return GraphNode.RESULT_FORMATTER;
  }
  if (
    state.resourcePattern &&
    state.resourceQueue &&
    state.resourceQueue.length > (state.currentResourceIndex ?? 0) &&
    (state.currentResourceIndex ?? 0) > 0
  ) {
    return GraphNode.RESOURCE_PROVISIONER;
  }
  return GraphNode.HUMAN_APPROVAL;
}

/** Routes after resource_provisioner: IN_PROGRESS → poller, else → result. */
export function routeResourceProvisioner(
  state: AgentState,
): typeof GraphNode.STATUS_POLLER | typeof GraphNode.RESULT_FORMATTER {
  return state.executionStatus === ExecutionStatus.IN_PROGRESS
    ? GraphNode.STATUS_POLLER
    : GraphNode.RESULT_FORMATTER;
}

/** Routes status_poller self-loop: IN_PROGRESS → self, else → result. */
export function routeStatusPoller(
  state: AgentState,
): typeof GraphNode.STATUS_POLLER | typeof GraphNode.RESULT_FORMATTER {
  return state.executionStatus === ExecutionStatus.IN_PROGRESS
    ? GraphNode.STATUS_POLLER
    : GraphNode.RESULT_FORMATTER;
}

/** Routes after result_formatter: compound pending → plan_generator loop, else → END.
 *  Works in both plan and apply modes so compound patterns render all resources.
 *
 *  SAFETY: when a compound resource is blocked by a preflight / BP failure
 *  in APPLY mode, the preflight guard keeps executionStatus = PENDING but
 *  sets preflightPassed = false. Without this guard, the graph would loop
 *  plan_generator → preflight_guard → result_formatter → plan_generator
 *  forever on the same resource until LangGraph's recursionLimit trips,
 *  producing a confusing "Recursion limit of 500 reached" error. Treat a
 *  failed preflight as a terminal state for the compound loop. */
export function routeResultFormatter(
  state: AgentState,
): typeof GraphNode.PLAN_GENERATOR | typeof END {
  if (
    state.resourcePattern &&
    state.resourceQueue &&
    state.currentResourceIndex !== undefined &&
    state.executionStatus === ExecutionStatus.PENDING &&
    state.currentResourceIndex < state.resourceQueue.length &&
    state.preflightPassed !== false
  ) {
    return GraphNode.PLAN_GENERATOR;
  }
  return END;
}
