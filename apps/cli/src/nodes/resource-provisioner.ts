/**
 * resource_provisioner node — State Guard (FR-15 Read-Before-Write) then CloudControl create.
 * Runs in Phase 2 of apply, after the LangGraph HITL interrupt is resumed.
 *
 * Uses @aws-sdk/client-cloudcontrol directly (replaces deprecated ccapi-mcp-server).
 *
 * @see Story 7-6
 */

import {
  ExecutionStatus,
  getPrimaryIdentifier,
  SUPPORTED_TYPES_ARRAY,
  type ResourceType,
} from "@assignee/core";

function isResourceType(s: string): s is ResourceType {
  return (SUPPORTED_TYPES_ARRAY as readonly string[]).includes(s);
}
import {
  CreateResourceCommand,
  GetResourceCommand,
} from "@aws-sdk/client-cloudcontrol";
import { getCloudControlClient } from "../services/cloudcontrol-client.js";
import { injectMandatoryTags } from "../utils/tags.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

export async function resourceProvisionerNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (state.executionStatus === ExecutionStatus.CANCELLED) return {};

  if (!state.desiredState) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Cannot provision: desiredState is missing.",
    };
  }

  const client = getCloudControlClient();

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
    try {
      await client.send(
        new GetResourceCommand({
          TypeName: state.resourceType,
          Identifier: identifier,
        }),
      );
      // Success = resource already exists = stale plan
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
    } catch (err) {
      if ((err as { name?: string }).name !== "ResourceNotFoundException") {
        return {
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `State Guard failed: ${String(err)}`,
        };
      }
      // ResourceNotFoundException = safe to proceed
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
    state.resourceType,
  );

  // ── CloudControl async create ─────────────────────────────────────────────
  try {
    const createResult = await client.send(
      new CreateResourceCommand({
        TypeName: state.resourceType,
        DesiredState: JSON.stringify(propertiesWithTags),
        ClientToken: state.runId,
      }),
    );

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
      requestToken,
      resourceType: state.resourceType,
    });

    return {
      requestToken,
      executionStatus: ExecutionStatus.IN_PROGRESS,
      startedAt: Date.now(),
    };
  } catch (err: unknown) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `CloudControl provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
