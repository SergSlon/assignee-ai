/**
 * resource_provisioner node — State Guard (FR-15 Read-Before-Write) then CCAPI create.
 * Runs in Phase 2 of apply, after the LangGraph HITL interrupt is resumed.
 *
 * CCAPI workflow (awslabs.ccapi-mcp-server v1+):
 *   1. get_aws_account_info          → credentials_token
 *   2. generate_infrastructure_code  → generated_code_token
 *   3. explain                       → explained_token
 *   4. run_checkov                   → security_scan_token
 *   5. create_resource               → request_token (async poll via status_poller)
 *
 * @see Story 2-2
 */

import { ExecutionStatus, getPrimaryIdentifier } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { injectMandatoryTags } from "../utils/tags.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

const REQUIRED_TOOLS = [
  ToolName.GET_AWS_ACCOUNT_INFO,
  ToolName.GENERATE_INFRASTRUCTURE_CODE,
  ToolName.EXPLAIN,
  ToolName.RUN_CHECKOV,
  ToolName.CREATE_RESOURCE,
] as const;

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

  const get = (name: string) => tools?.find((t) => t.name === name);

  const missingTool = REQUIRED_TOOLS.find((name) => !get(name));
  if (missingTool) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `ccapi-mcp-server not available: missing tool '${missingTool}'.`,
    };
  }

  // ── State Guard (FR-15 Read-Before-Write) ────────────────────────────────
  const identifier = getPrimaryIdentifier(
    state.resourceType as Parameters<typeof getPrimaryIdentifier>[0],
    state.desiredState,
  );

  const getResource = get(ToolName.GET_RESOURCE);
  if (getResource && identifier) {
    try {
      await getResource.invoke({
        resource_type: state.resourceType,
        identifier,
      });
      // If invoke succeeds, the resource already exists
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.STATE_GUARD_ABORT,
        identifier,
        resourceType: state.resourceType,
      });
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Stale Plan: Resource already exists (${identifier}). Re-run 'assignee plan' to refresh.`,
      };
    } catch {
      // Resource not found — safe to proceed
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
        reason: "not_found",
      });
    }
  }

  // ── Inject mandatory tags (NFR-14) ───────────────────────────────────────
  const propertiesWithTags = injectMandatoryTags(
    state.desiredState,
    state.runId,
  );

  // ── CCAPI 4-step provisioning workflow ───────────────────────────────────
  try {
    // Step 1: validate credentials
    const accountRaw = await get(ToolName.GET_AWS_ACCOUNT_INFO)!.invoke({});
    const { credentials_token } = JSON.parse(accountRaw as string);

    // Step 2: generate infrastructure code
    const codeRaw = await get(ToolName.GENERATE_INFRASTRUCTURE_CODE)!.invoke({
      resource_type: state.resourceType,
      properties: propertiesWithTags,
      credentials_token,
    });
    const { generated_code_token } = JSON.parse(codeRaw as string);

    // Step 3: explain (produces explained_token required by create_resource)
    const explainRaw = await get(ToolName.EXPLAIN)!.invoke({
      generated_code_token,
      operation: "create",
    });
    const { explained_token } = JSON.parse(explainRaw as string);

    // Step 4: security scan
    const checkovRaw = await get(ToolName.RUN_CHECKOV)!.invoke({
      explained_token,
    });
    const { security_scan_token } = JSON.parse(checkovRaw as string);

    // Step 5: create resource (async — poll via status_poller)
    const createRaw = await get(ToolName.CREATE_RESOURCE)!.invoke({
      resource_type: state.resourceType,
      credentials_token,
      explained_token,
      security_scan_token,
    });
    const { request_token: requestToken } = JSON.parse(createRaw as string);

    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
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
