/**
 * Conditional routing functions for the LangGraph agent graph.
 * Separated from graph.ts for clarity and testability.
 */

import { END } from "@langchain/langgraph";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import { GraphNode } from "../constants/graph.js";
import type { AgentState } from "./graph-state.js";

/** Routes after preflight_guard: plan → result, apply → approval or provisioner. */
export function routePreflightGuard(
  state: AgentState,
):
  | typeof GraphNode.HUMAN_APPROVAL
  | typeof GraphNode.RESULT_FORMATTER
  | typeof GraphNode.RESOURCE_PROVISIONER {
  if (state.executionMode === ExecutionMode.PLAN || !state.preflightPassed) {
    return GraphNode.RESULT_FORMATTER;
  }
  if (state.resourcePattern && (state.currentResourceIndex ?? 0) > 0) {
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
 *  Plan mode shows only the first resource — no loop. */
export function routeResultFormatter(
  state: AgentState,
): typeof GraphNode.PLAN_GENERATOR | typeof END {
  if (
    state.resourcePattern &&
    state.resourceQueue &&
    state.currentResourceIndex !== undefined &&
    state.executionStatus === ExecutionStatus.PENDING &&
    state.currentResourceIndex < state.resourceQueue.length &&
    state.executionMode !== ExecutionMode.PLAN
  ) {
    return GraphNode.PLAN_GENERATOR;
  }
  return END;
}
