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
import { injectMandatoryTags } from "../utils/tags.js";
import { log } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

const REQUIRED_TOOLS = [
  "get_aws_account_info",
  "generate_infrastructure_code",
  "explain",
  "run_checkov",
  "create_resource",
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

  const getResource = get("get_resource");
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
        action: "state_guard_abort",
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
        action: "state_guard_skipped",
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
    const accountRaw = await get("get_aws_account_info")!.invoke({});
    const { credentials_token } = JSON.parse(accountRaw as string);

    // Step 2: generate infrastructure code
    const codeRaw = await get("generate_infrastructure_code")!.invoke({
      resource_type: state.resourceType,
      properties: propertiesWithTags,
      credentials_token,
    });
    const { generated_code_token } = JSON.parse(codeRaw as string);

    // Step 3: explain (produces explained_token required by create_resource)
    const explainRaw = await get("explain")!.invoke({
      generated_code_token,
      operation: "create",
    });
    const { explained_token } = JSON.parse(explainRaw as string);

    // Step 4: security scan
    const checkovRaw = await get("run_checkov")!.invoke({ explained_token });
    const { security_scan_token } = JSON.parse(checkovRaw as string);

    // Step 5: create resource (async — poll via status_poller)
    const createRaw = await get("create_resource")!.invoke({
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
