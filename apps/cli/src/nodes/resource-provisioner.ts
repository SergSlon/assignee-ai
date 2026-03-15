/**
 * resource_provisioner node — State Guard (FR-15 Read-Before-Write) then CCAPI create.
 * Runs in Phase 2 of apply, after the LangGraph HITL interrupt is resumed.
 *
 * @see Story 2-2
 */

import { ExecutionStatus, getPrimaryIdentifier } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { injectMandatoryTags } from "../utils/tags.js";
import { log } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

export async function resourceProvisionerNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  if (state.executionStatus === ExecutionStatus.CANCELLED) return {};

  if (!state.desiredState) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Cannot provision: desiredState is missing.",
    };
  }

  const getResource = tools?.find((t) => t.name === "aws_ccapi_get_resource");
  const createResource = tools?.find(
    (t) => t.name === "aws_ccapi_create_resource",
  );

  if (!createResource) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "ccapi-mcp-server not available. Hint: ensure the MCP server is installed and running.",
    };
  }

  // ── State Guard (FR-15 Read-Before-Write) ────────────────────────────────
  const identifier = getPrimaryIdentifier(
    state.resourceType as Parameters<typeof getPrimaryIdentifier>[0],
    state.desiredState,
  );

  if (getResource && identifier) {
    try {
      const existing = await getResource.invoke({
        type_name: state.resourceType,
        identifier,
      });
      if (existing) {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: "state_guard_abort",
          identifier,
          resourceType: state.resourceType,
        });
        return {
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `Stale Plan: Resource already exists (${identifier}). Re-run 'assignee plan' to refresh.`,
        };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const reason = errMsg.includes("UnsupportedActionException")
        ? "UnsupportedActionException"
        : errMsg.includes("ResourceNotFoundException") ||
            errMsg.includes("does not exist")
          ? "not_found"
          : errMsg;

      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: "state_guard_skipped",
        reason,
      });
      // Proceed — resource not found or action unsupported
    }
  }

  // ── Inject mandatory tags (NFR-14) ───────────────────────────────────────
  // injectMandatoryTags handles the full desiredState and produces [{Key,Value}] format
  const desiredStateWithTags = injectMandatoryTags(
    state.desiredState,
    state.runId,
  );

  // ── Create resource ───────────────────────────────────────────────────────
  try {
    const result = await createResource.invoke({
      type_name: state.resourceType,
      desired_state: JSON.stringify(desiredStateWithTags),
      client_token: state.runId, // NFR-11 correlation token
    });

    const parsed =
      typeof result === "string"
        ? (JSON.parse(result) as Record<string, unknown>)
        : result;
    const event =
      (parsed as Record<string, unknown>)?.["ProgressEvent"] ?? parsed;
    const requestToken =
      (event as Record<string, unknown>)?.["RequestToken"] ??
      (parsed as Record<string, unknown>)?.["requestToken"] ??
      state.runId;

    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: "resource_provision_started",
      requestToken,
      resourceType: state.resourceType,
    });

    return {
      requestToken: String(requestToken),
      executionStatus: ExecutionStatus.IN_PROGRESS,
      startedAt: Date.now(),
    };
  } catch (err: unknown) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Resource creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
