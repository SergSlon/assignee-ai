/**
 * resource_provisioner node — State Guard (FR-15 Read-Before-Write) then CloudControl create.
 * Runs in Phase 2 of apply, after the LangGraph HITL interrupt is resumed.
 *
 * Uses @aws-sdk/client-cloudcontrol directly (replaces deprecated ccapi-mcp-server).
 *
 * @see Story 7-6, Story 9-2
 */

import {
  ExecutionStatus,
  getPrimaryIdentifier,
  SUPPORTED_TYPES_ARRAY,
  type ResourceType,
  safeTry,
  ProvisioningError,
} from "@assignee/core";

function isResourceType(s: string): s is ResourceType {
  return (SUPPORTED_TYPES_ARRAY as readonly string[]).includes(s);
}
import {
  type CloudControlClient,
  CreateResourceCommand,
  GetResourceCommand,
  ResourceNotFoundException,
  AlreadyExistsException,
  ThrottlingException,
  GeneralServiceException,
} from "@aws-sdk/client-cloudcontrol";
import { injectMandatoryTags } from "../utils/tags.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

export async function resourceProvisionerNode(
  state: AgentState,
  client: CloudControlClient,
): Promise<Partial<AgentState>> {
  if (state.executionStatus === ExecutionStatus.CANCELLED) return {};

  if (!state.desiredState) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Cannot provision: desiredState is missing.",
    };
  }

  // ── State Guard (FR-15 Read-Before-Write) ────────────────────────────────
  if (!state.resourceType || !isResourceType(state.resourceType)) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Cannot provision: unsupported or missing resourceType "${state.resourceType ?? ""}".`,
    };
  }
  const identifier = getPrimaryIdentifier(
    state.resourceType,
    state.desiredState,
  );

  if (identifier) {
    const [stateGuardErr] = await safeTry(
      client.send(
        new GetResourceCommand({
          TypeName: state.resourceType,
          Identifier: identifier,
        }),
      ),
    );

    if (!stateGuardErr) {
      // No error = resource already exists = stale plan
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.STATE_GUARD_ABORT,
        extras: { identifier, resourceType: state.resourceType },
      });
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Stale Plan: Resource already exists (${identifier}). Re-run 'assignee plan' to refresh.`,
        error: new ProvisioningError(
          `Stale Plan: Resource already exists (${identifier})`,
          "StateMismatch",
        ),
      };
    }

    if (!(stateGuardErr instanceof ResourceNotFoundException)) {
      const errMsg =
        stateGuardErr instanceof Error
          ? stateGuardErr.message
          : String(stateGuardErr);
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `State Guard failed: ${errMsg}`,
        error: new ProvisioningError(errMsg, "Unknown"),
      };
    }

    // ResourceNotFoundException = safe to proceed
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
      extras: { reason: "not_found" },
    });
  }

  // ── Inject mandatory tags (NFR-14) ───────────────────────────────────────
  const propertiesWithTags = injectMandatoryTags(
    state.desiredState,
    state.runId,
    state.resourceType,
  );

  // ── CloudControl async create ─────────────────────────────────────────────
  const [createErr, createResult] = await safeTry(
    client.send(
      new CreateResourceCommand({
        TypeName: state.resourceType,
        DesiredState: JSON.stringify(propertiesWithTags),
        ClientToken: state.runId,
      }),
    ),
  );

  if (createErr) {
    if (createErr instanceof AlreadyExistsException) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `CloudControl provisioning failed: Resource already exists. Re-run 'assignee plan' to refresh.`,
        error: new ProvisioningError(
          "Resource already exists",
          "AlreadyExists",
        ),
      };
    }
    if (createErr instanceof ThrottlingException) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `CloudControl provisioning failed: Request throttled by AWS. Please wait and retry.`,
        error: new ProvisioningError("Request throttled by AWS", "Throttled"),
      };
    }
    if (createErr instanceof GeneralServiceException) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `CloudControl provisioning failed: ${createErr.message}`,
        error: new ProvisioningError(createErr.message, "Unknown"),
      };
    }
    const errMsg =
      createErr instanceof Error ? createErr.message : String(createErr);
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `CloudControl provisioning failed: ${errMsg}`,
      error: new ProvisioningError(errMsg, "Unknown"),
    };
  }

  const requestToken = createResult.ProgressEvent?.RequestToken;
  if (!requestToken) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "CloudControl provisioning failed: CreateResource returned no RequestToken.",
    };
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
    extras: { requestToken, resourceType: state.resourceType },
  });

  return {
    requestToken,
    executionStatus: ExecutionStatus.IN_PROGRESS,
    startedAt: Date.now(),
  };
}
