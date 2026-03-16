/**
 * status_poller node — polls CloudControl for async operation status.
 * LangGraph self-loop: returns IN_PROGRESS to re-invoke itself, or routes to result_formatter.
 * Timeout: 5 minutes; poll interval: 2 seconds.
 *
 * Uses @aws-sdk/client-cloudcontrol directly (replaces deprecated ccapi-mcp-server).
 *
 * @see Story 7-6
 */

import { ExecutionStatus } from "@assignee/core";
import { GetResourceRequestStatusCommand } from "@aws-sdk/client-cloudcontrol";
import { getCloudControlClient } from "../services/cloudcontrol-client.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2_000; // 2 seconds

/** Provisioning operation status values returned by CloudControl SDK */
const ProvisioningStatus = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCEL_COMPLETE: "CANCEL_COMPLETE",
} as const;

export async function statusPollerNode(
  state: AgentState,
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

  const client = getCloudControlClient();

  try {
    const result = await client.send(
      new GetResourceRequestStatusCommand({
        RequestToken: state.requestToken,
      }),
    );

    const event = result.ProgressEvent;
    const status = event?.OperationStatus as string | undefined;
    const resourceIdentifier = event?.Identifier;
    const errorMessage = event?.StatusMessage;

    const durationMs = Date.now() - startedAt;

    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PROVISIONING_STATUS_CHECKED,
      durationMs,
      status,
    });

    if (
      status === ProvisioningStatus.FAILED ||
      status === ProvisioningStatus.CANCEL_COMPLETE
    ) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          typeof errorMessage === "string"
            ? errorMessage
            : "Resource provisioning failed.",
      };
    }

    if (status === ProvisioningStatus.SUCCESS) {
      return {
        executionStatus: ExecutionStatus.SUCCESS,
        resourceArn: resourceIdentifier,
      };
    }

    // Still IN_PROGRESS — LangGraph self-loop will re-invoke this node
    return { executionStatus: ExecutionStatus.IN_PROGRESS };
  } catch (err: unknown) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `CloudControl polling failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
