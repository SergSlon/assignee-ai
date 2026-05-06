/**
 * Conditional routing functions for the LangGraph agent graph.
 * Separated from create-graph.ts for clarity and testability.
 *
 * Story 50-4 Wave 5 Pass I: lifted from
 * `apps/cli/src/services/graph-routing.ts` into `@assignee/core/graph`
 * so the in-core `createGraph` can reference them without a back-import
 * into the CLI.
 */

import { END } from "@langchain/langgraph";
import { ExecutionMode, ExecutionStatus } from "../index.js";
import { GraphNode } from "../constants/graph-node.js";
import type { AgentState } from "./graph-state.js";

/**
 * Routes after intent_parser:
 * - QUERY_INTENT → query_handler (bypasses creation pipeline)
 * - FAILED / UNSUPPORTED_RESOURCE → result_formatter directly (short-circuits
 *   creation pipeline for terminal states so schema_fetcher / wizard / plan
 *   don't fire on a payload that will never be provisioned)
 * - Else → schema_fetcher (normal creation path)
 *
 * MED 4 fix: without the FAILED/UNSUPPORTED_RESOURCE check, destroy-redirect
 * messages (BLOCKER 1 fix) and hallucinated-type errors (HIGH 5 fix) fell
 * through to schema_fetcher, producing confusing downstream errors.
 *
 * Story: feature-query-intent-classifier
 */
export function routeIntentParser(
  state: AgentState,
):
  | typeof GraphNode.SCHEMA_FETCHER
  | typeof GraphNode.QUERY_HANDLER
  | typeof GraphNode.RESULT_FORMATTER {
  if (state.executionStatus === ExecutionStatus.QUERY_INTENT) {
    return GraphNode.QUERY_HANDLER;
  }
  if (
    state.executionStatus === ExecutionStatus.FAILED ||
    state.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
  ) {
    return GraphNode.RESULT_FORMATTER;
  }
  return GraphNode.SCHEMA_FETCHER;
}

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

/**
 * Routes after validate_desired_state: FAILED (invalid bucket name, etc.)
 * short-circuits to RESULT_FORMATTER so the user sees the actionable
 * `[ERROR] / [FIX]` triple before we waste tokens on advice / BP / fix /
 * preflight for a payload that cannot provision. Happy path falls through
 * to ADVICE_GENERATOR.
 *
 * Epic 94 R1 (A-01): this routing is the gate that actually activates the
 * `validateDesiredStateNode` shipped in Epic 92 u.c.1 — without it, the
 * node was dead code.
 */
export function routeValidateDesiredState(
  state: AgentState,
): typeof GraphNode.ADVICE_GENERATOR | typeof GraphNode.RESULT_FORMATTER {
  if (
    state.executionStatus === ExecutionStatus.FAILED ||
    state.executionStatus === ExecutionStatus.CANCELLED ||
    state.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE ||
    state.executionStatus === ExecutionStatus.POLICY_BLOCKED
  ) {
    return GraphNode.RESULT_FORMATTER;
  }
  return GraphNode.ADVICE_GENERATOR;
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

/** Routes status_poller: IN_PROGRESS → self, retry → provisioner, else → result.
 *  Retry path: status_poller signals "retry needed" by staying IN_PROGRESS
 *  but clearing requestToken. The router detects this and sends the flow
 *  back to resource_provisioner, which waits 30s then re-creates. */
export function routeStatusPoller(
  state: AgentState,
):
  | typeof GraphNode.STATUS_POLLER
  | typeof GraphNode.RESULT_FORMATTER
  | typeof GraphNode.RESOURCE_PROVISIONER {
  if (state.executionStatus === ExecutionStatus.IN_PROGRESS) {
    // Retry path: IN_PROGRESS + no requestToken = need a new provision attempt
    if (!state.requestToken) {
      return GraphNode.RESOURCE_PROVISIONER;
    }
    return GraphNode.STATUS_POLLER;
  }
  return GraphNode.RESULT_FORMATTER;
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
