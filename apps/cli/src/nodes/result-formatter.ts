/**
 * result_formatter node — final rendering gate.
 * Handles all terminal outcomes: SUCCESS, FAILED, CANCELLED, and plan-mode preview.
 *
 * @see Story 2-4, Story 9-6
 */

import {
  ExecutionStatus,
  ExecutionMode,
  defaultErrorHintRegistry,
} from "@assignee/core";
import {
  renderApplySuccess,
  renderError,
  renderPlanBox,
} from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

export async function resultFormatterNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESULT_FORMATTED,
    extras: { executionStatus: state.executionStatus },
  });

  switch (state.executionStatus) {
    case ExecutionStatus.SUCCESS:
      renderApplySuccess(state);
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.APPLY_SUCCEEDED,
        extras: { resourceArn: state.resourceArn },
      });
      break;

    case ExecutionStatus.CANCELLED:
      // Silent exit — user intentionally declined
      break;

    case ExecutionStatus.FAILED:
    case ExecutionStatus.POLICY_BLOCKED:
    case ExecutionStatus.UNSUPPORTED_RESOURCE:
      renderError(
        state.errorMessage ?? "An unknown error occurred",
        defaultErrorHintRegistry.getHint(state.error),
      );
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "error",
        action: LOG_ACTIONS.APPLY_FAILED,
        extras: { errorMessage: state.errorMessage },
      });
      break;

    default:
      // PENDING = plan mode — render plan preview box
      if (state.executionMode === ExecutionMode.PLAN) {
        renderPlanBox(state);
      }
      break;
  }

  return {};
}
