/**
 * Error/failure formatter — FAILED, POLICY_BLOCKED, UNSUPPORTED_RESOURCE.
 *
 * For compound mode with partial progress, delegate to renderCompoundPartialFailure
 * which surfaces success / failure / not-attempted / recovery as discrete blocks.
 * Otherwise, render a single error box.
 */

import { ExecutionStatus, defaultErrorHintRegistry } from "@assignee/core";
import type { AgentState } from "../../../services/graph.js";
import {
  renderCompoundPartialFailure,
  renderError,
} from "../../../utils/display.js";
import { defaultErrorMessageRegistry } from "../../../utils/error-messages.js";
import { log, LOG_ACTIONS } from "../../../utils/logger.js";
import { writeFailureRecord } from "../../../utils/memory-recorder.js";

export async function formatErrorResult(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const resolved = state.error
    ? defaultErrorMessageRegistry.resolve(state.error)
    : defaultErrorMessageRegistry.resolveMessage(
        state.errorMessage ?? "An unknown error occurred",
      );

  const legacyHint = defaultErrorHintRegistry.getHint(state.error);

  if (
    state.resourcePattern &&
    state.resourceQueue &&
    state.completedResources &&
    state.completedResources.length > 0 &&
    state.currentResourceIndex !== undefined
  ) {
    const successfulResources = state.completedResources.filter(
      (r) => r.executionStatus === ExecutionStatus.SUCCESS,
    );
    const failedResourceSpec = state.resourceQueue[state.currentResourceIndex];
    const notAttempted = state.resourceQueue.slice(
      state.currentResourceIndex + 1,
    );

    renderCompoundPartialFailure({
      pattern: state.resourcePattern,
      completed: successfulResources,
      failedResource: {
        resourceId: failedResourceSpec?.resourceId ?? "unknown",
        resourceType:
          failedResourceSpec?.resourceType ?? state.resourceType ?? "unknown",
        displayName: failedResourceSpec?.displayName,
        errorMessage: resolved.what,
      },
      notAttempted,
      runId: state.runId,
    });
    if (resolved.why || legacyHint || resolved.howToFix) {
      renderError(
        `Compound apply halted — see the Compound Provisioning Halted box above for recoverable state.`,
        legacyHint ?? resolved.howToFix,
        { why: resolved.why },
      );
    }
  } else {
    renderError(resolved.what, legacyHint ?? resolved.howToFix, {
      why: resolved.why,
    });
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "error",
    action: LOG_ACTIONS.APPLY_FAILED,
    extras: { errorMessage: state.errorMessage },
  });

  await writeFailureRecord(
    state.runId,
    state.resourceType,
    state.error,
    state.errorMessage,
  );

  return {};
}
