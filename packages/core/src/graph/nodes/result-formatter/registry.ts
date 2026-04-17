/**
 * Mode → formatter dispatcher.
 *
 * SUCCESS branches split by shape: compound (resourcePattern + resourceQueue
 * + currentResourceIndex all defined) vs single-resource.
 *
 * FAILED / POLICY_BLOCKED / UNSUPPORTED_RESOURCE all go through the error
 * formatter which handles both single and compound-partial shapes.
 *
 * CANCELLED is a silent no-op.
 *
 * Anything else (PENDING) falls through to the plan formatter.
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../../graph-state.js";
import { formatApplyCompoundSuccess } from "./formatters/apply-compound.js";
import { formatApplySingleSuccess } from "./formatters/apply-single.js";
import { formatErrorResult } from "./formatters/error.js";
import { formatPlanResult } from "./formatters/plan.js";

function isCompoundShape(state: AgentState): boolean {
  return Boolean(
    state.resourcePattern &&
    state.resourceQueue &&
    state.currentResourceIndex !== undefined,
  );
}

export async function dispatchFormatter(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  switch (state.executionStatus) {
    case ExecutionStatus.SUCCESS:
      return isCompoundShape(state)
        ? formatApplyCompoundSuccess(state, tools)
        : formatApplySingleSuccess(state, tools);

    case ExecutionStatus.CANCELLED:
      // Silent exit — user intentionally declined.
      return {};

    case ExecutionStatus.FAILED:
    case ExecutionStatus.POLICY_BLOCKED:
    case ExecutionStatus.UNSUPPORTED_RESOURCE:
      return formatErrorResult(state);

    default:
      return formatPlanResult(state);
  }
}
