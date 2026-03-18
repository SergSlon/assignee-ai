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
  type ResourceResult,
} from "@assignee/core";
import {
  renderApplySuccess,
  renderCompoundSuccess,
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
    case ExecutionStatus.SUCCESS: {
      // Compound mode: accumulate result and signal loop to continue
      if (
        state.resourcePattern &&
        state.resourceQueue &&
        state.currentResourceIndex !== undefined
      ) {
        const currentResource = state.resourceQueue[state.currentResourceIndex];
        if (!currentResource) return {};
        const completedEntry: ResourceResult = {
          resourceId: currentResource.resourceId,
          resourceType: currentResource.resourceType,
          resourceArn: state.resourceArn,
          executionStatus: ExecutionStatus.SUCCESS,
        };
        const updatedCompleted = [
          ...(state.completedResources ?? []),
          completedEntry,
        ];
        const nextIndex = state.currentResourceIndex + 1;

        if (nextIndex < state.resourceQueue.length) {
          // More resources to provision — update state for next iteration
          const nextResource = state.resourceQueue[nextIndex];
          if (!nextResource) break;
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "info",
            action: LOG_ACTIONS.APPLY_SUCCEEDED,
            extras: {
              resourceArn: state.resourceArn,
              resourceType: currentResource.resourceType,
              compound: true,
            },
          });
          return {
            completedResources: updatedCompleted,
            currentResourceIndex: nextIndex,
            resourceType: nextResource.resourceType,
            desiredState: undefined,
            requestToken: undefined,
            resourceArn: undefined,
            executionStatus: ExecutionStatus.PENDING, // Reset for next resource
          };
        }

        // All resources provisioned — render compound summary
        renderCompoundSuccess(updatedCompleted, state.resourcePattern);
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.APPLY_SUCCEEDED,
          extras: { compound: true, completedCount: updatedCompleted.length },
        });
        return { completedResources: updatedCompleted };
      }

      // Single-resource path — unchanged
      renderApplySuccess(state);
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.APPLY_SUCCEEDED,
        extras: { resourceArn: state.resourceArn },
      });
      break;
    }

    case ExecutionStatus.CANCELLED:
      // Silent exit — user intentionally declined
      break;

    case ExecutionStatus.FAILED:
    case ExecutionStatus.POLICY_BLOCKED:
    case ExecutionStatus.UNSUPPORTED_RESOURCE:
      // Compound mode: show partial results with cleanup message
      if (
        state.resourcePattern &&
        state.completedResources &&
        state.completedResources.length > 0
      ) {
        const provisioned = state.completedResources
          .filter((r) => r.executionStatus === ExecutionStatus.SUCCESS)
          .map((r) => r.resourceType)
          .join(", ");
        const haltedAt = state.resourceType ?? "unknown resource";
        renderError(
          `Provision halted at ${haltedAt}. Previously provisioned: ${provisioned}. Manual cleanup may be required.`,
          defaultErrorHintRegistry.getHint(state.error),
        );
      } else {
        renderError(
          state.errorMessage ?? "An unknown error occurred",
          defaultErrorHintRegistry.getHint(state.error),
        );
      }
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
