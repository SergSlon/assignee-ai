/**
 * status_poller node — polls CloudControl for async operation status.
 * LangGraph self-loop: returns IN_PROGRESS to re-invoke itself, or routes to result_formatter.
 * Timeout: 5 minutes; poll interval: 2 seconds.
 *
 * Depends on ProvisioningPort (DIP) — no direct AWS SDK imports.
 *
 * @see Story 7-6, Story 9-2
 */

import { ExecutionStatus } from "@assignee/core";
import type { ProvisioningPort } from "../services/provisioning-port.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph-state.js";

const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2_000; // 2 seconds

const ProvisioningStatus = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCEL_COMPLETE: "CANCEL_COMPLETE",
} as const;

export async function statusPollerNode(
  state: AgentState,
  provisioner: ProvisioningPort,
): Promise<Partial<AgentState>> {
  if (!state.requestToken) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "No request token to poll. Hint: resource_provisioner may not have run.",
    };
  }

  // Timeout guard
  const startedAt = state.startedAt ?? Date.now();
  if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "Resource provisioning timed out after 5 minutes. Hint: check the AWS CloudFormation console for resource status.",
    };
  }

  // Wait between polls
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

  const [pollErr, result] = await provisioner.getRequestStatus(
    state.requestToken,
  );

  if (pollErr) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `CloudControl polling failed: ${pollErr.message}`,
    };
  }

  const status = result.operationStatus;
  const durationMs = Date.now() - startedAt;

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PROVISIONING_STATUS_CHECKED,
    durationMs,
    extras: { status },
  });

  if (
    status === ProvisioningStatus.FAILED ||
    status === ProvisioningStatus.CANCEL_COMPLETE
  ) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        typeof result.statusMessage === "string"
          ? result.statusMessage
          : "Resource provisioning failed.",
    };
  }

  if (status === ProvisioningStatus.SUCCESS) {
    return {
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: result.identifier,
    };
  }

  // Still IN_PROGRESS — LangGraph self-loop will re-invoke this node
  return { executionStatus: ExecutionStatus.IN_PROGRESS };
}
