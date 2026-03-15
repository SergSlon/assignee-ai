/**
 * status_poller node — polls CCAPI for async operation status.
 * LangGraph self-loop: returns IN_PROGRESS to re-invoke itself, or routes to result_formatter.
 * Timeout: 5 minutes; poll interval: 2 seconds.
 *
 * @see Story 2-3
 */

import { ExecutionStatus } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { log } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2_000; // 2 seconds

export async function statusPollerNode(
  state: AgentState,
  tools?: StructuredTool[],
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

  const getStatus = tools?.find(
    (t) => t.name === "aws_ccapi_get_resource_request_status",
  );
  if (!getStatus) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "ccapi-mcp-server not available for status polling.",
    };
  }

  // Wait between polls
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

  try {
    const result = await getStatus.invoke({
      request_token: state.requestToken,
    });
    const parsed =
      typeof result === "string"
        ? (JSON.parse(result) as Record<string, unknown>)
        : result;
    const event =
      (parsed as Record<string, unknown>)?.["ProgressEvent"] ??
      (parsed as Record<string, unknown>);

    const operationStatus =
      (event as Record<string, unknown>)?.["OperationStatus"] ??
      (event as Record<string, unknown>)?.["operationStatus"];

    const durationMs = Date.now() - startedAt;

    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: "provisioning_status_checked",
      durationMs,
      operationStatus,
    });

    if (operationStatus === "SUCCESS") {
      const resourceArn =
        (
          (event as Record<string, unknown>)?.["ResourceModel"] as Record<
            string,
            unknown
          >
        )?.["Arn"] ??
        (event as Record<string, unknown>)?.["Identifier"] ??
        undefined;

      return {
        executionStatus: ExecutionStatus.SUCCESS,
        resourceArn: typeof resourceArn === "string" ? resourceArn : undefined,
      };
    }

    if (operationStatus === "FAILED" || operationStatus === "CANCEL_COMPLETE") {
      const statusMessage = (event as Record<string, unknown>)?.[
        "StatusMessage"
      ];
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          typeof statusMessage === "string"
            ? statusMessage
            : "Resource provisioning failed.",
      };
    }

    // Still IN_PROGRESS — LangGraph self-loop will re-invoke this node
    return { executionStatus: ExecutionStatus.IN_PROGRESS };
  } catch (err: unknown) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Status polling failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
