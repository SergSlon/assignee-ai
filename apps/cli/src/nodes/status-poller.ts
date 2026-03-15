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
    (t) => t.name === "get_resource_request_status",
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

    // ccapi-mcp-server v1+: response is { type: "text", text: "<json>" }
    // or a plain string; unwrap accordingly
    const raw = result as Record<string, unknown>;
    const text =
      typeof raw?.["text"] === "string"
        ? raw["text"]
        : typeof result === "string"
          ? result
          : JSON.stringify(result);
    const parsed = JSON.parse(text) as Record<string, unknown>;

    const status = parsed?.["status"] as string | undefined;
    const isComplete = parsed?.["is_complete"] as boolean | undefined;
    const resourceIdentifier = parsed?.["resource_identifier"] as
      | string
      | undefined;

    const durationMs = Date.now() - startedAt;

    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: "provisioning_status_checked",
      durationMs,
      status,
      isComplete,
    });

    if (status === "FAILED" || status === "CANCEL_COMPLETE") {
      const errorMessage = parsed?.["error_message"] ?? parsed?.["message"];
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          typeof errorMessage === "string"
            ? errorMessage
            : "Resource provisioning failed.",
      };
    }

    if (status === "SUCCESS" || isComplete === true) {
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
      errorMessage: `Status polling failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
