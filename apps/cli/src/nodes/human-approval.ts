/**
 * human_approval node — shows plan box and requests HITL confirmation.
 * Runs in Phase 1 of apply, before the LangGraph interrupt at resource_provisioner.
 * If user declines or cancels, sets executionStatus: CANCELLED.
 *
 * @see Story 2-1, Story 8-3
 */

import { ExecutionStatus } from "@assignee/core";
import {
  renderPlanBox,
  renderHitlConfirm,
  renderDependencyPlan,
  renderHitlCompoundConfirm,
} from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

export async function humanApprovalNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  let confirmed: boolean;

  if (state.resourcePattern && state.resourceQueue) {
    // Compound intent: show dependency plan (Story 8.3)
    renderDependencyPlan(
      state.resourcePattern,
      state.resourceQueue,
      state.perResourceCosts,
    );
    confirmed = await renderHitlCompoundConfirm(
      state.resourcePattern,
      state.resourceQueue.length,
    );
  } else {
    // Single-resource intent: existing behaviour — unchanged
    renderPlanBox(state);
    confirmed = await renderHitlConfirm(state);
  }

  if (!confirmed) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_REJECTED,
    });
    return { executionStatus: ExecutionStatus.CANCELLED };
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PLAN_APPROVED,
  });

  return {};
}
