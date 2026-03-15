/**
 * human_approval node — shows plan box and requests HITL confirmation.
 * Runs in Phase 1 of apply, before the LangGraph interrupt at resource_provisioner.
 * If user declines or cancels, sets executionStatus: CANCELLED.
 *
 * @see Story 2-1
 */

import { ExecutionStatus } from "@assignee/core";
import { renderPlanBox, renderHitlConfirm } from "../utils/ui.js";
import { log } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

export async function humanApprovalNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  // Show what will be applied
  renderPlanBox(state);

  const confirmed = await renderHitlConfirm(state);

  if (!confirmed) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: "plan_rejected_by_user",
    });
    return { executionStatus: ExecutionStatus.CANCELLED };
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: "plan_approved",
  });

  return {};
}
