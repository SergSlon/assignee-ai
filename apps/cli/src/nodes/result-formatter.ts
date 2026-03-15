/**
 * result_formatter node — final rendering gate.
 * Handles all terminal outcomes: SUCCESS, FAILED, CANCELLED, and plan-mode preview.
 *
 * @see Story 2-4
 */

import { ExecutionStatus, ExecutionMode } from "@assignee/core";
import {
  renderApplySuccess,
  renderError,
  renderPlanBox,
} from "../utils/display.js";
import { log } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

/** Maps known error substrings to actionable "How to Fix" hints. */
const ERROR_HINTS: Array<[pattern: string, hint: string]> = [
  [
    "BucketAlreadyExists",
    "Choose a unique bucket name — S3 bucket names must be globally unique.",
  ],
  [
    "EntityAlreadyExists",
    "A role or entity with this name already exists. Choose a different name.",
  ],
  [
    "ParameterAlreadyExists",
    "This SSM parameter already exists. Use the --overwrite flag to update it.",
  ],
  [
    "POLICY_BLOCKED",
    "This action was blocked by organisational policy. Contact your administrator.",
  ],
  ["Stale Plan", "Re-run 'assignee plan' to generate a fresh plan."],
  [
    "already exists",
    "The resource already exists. Choose a different name or re-run plan.",
  ],
];

function resolveHint(errorMessage?: string): string | undefined {
  if (!errorMessage) return undefined;
  for (const [pattern, hint] of ERROR_HINTS) {
    if (errorMessage.includes(pattern)) return hint;
  }
  return undefined;
}

export async function resultFormatterNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: "result_formatted",
    executionStatus: state.executionStatus,
  });

  switch (state.executionStatus) {
    case ExecutionStatus.SUCCESS:
      renderApplySuccess(state);
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: "apply_succeeded",
        resourceArn: state.resourceArn,
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
        resolveHint(state.errorMessage),
      );
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "error",
        action: "apply_failed",
        errorMessage: state.errorMessage,
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
