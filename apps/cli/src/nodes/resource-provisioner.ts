/**
 * resource_provisioner node — State Guard (FR-15 Read-Before-Write) then CloudControl create.
 * Runs in Phase 2 of apply, after the LangGraph HITL interrupt is resumed.
 *
 * Depends on ProvisioningPort (DIP) — no direct AWS SDK imports.
 *
 * @see Story 7-6, Story 9-2
 */

import {
  ExecutionStatus,
  getPrimaryIdentifier,
  SUPPORTED_TYPES_ARRAY,
  type ResourceType,
  ProvisioningError,
} from "@assignee/core";
import type { ProvisioningPort } from "../services/provisioning-port.js";
import { ProvisioningErrorKind } from "../services/provisioning-port.js";
import { injectMandatoryTags } from "../utils/tags.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph-state.js";

function isResourceType(s: string): s is ResourceType {
  return (SUPPORTED_TYPES_ARRAY as readonly string[]).includes(s);
}

export async function resourceProvisionerNode(
  state: AgentState,
  provisioner: ProvisioningPort,
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
    const [stateGuardErr] = await provisioner.getResource(
      state.resourceType,
      identifier,
    );

    if (!stateGuardErr) {
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

    if (stateGuardErr.kind !== ProvisioningErrorKind.NOT_FOUND) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `State Guard failed: ${stateGuardErr.message}`,
        error: new ProvisioningError(stateGuardErr.message, "Unknown"),
      };
    }

    // NOT_FOUND = safe to proceed
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
  const [createErr, createResult] = await provisioner.createResource(
    state.resourceType,
    JSON.stringify(propertiesWithTags),
    state.runId,
  );

  if (createErr) {
    const errorCategory =
      createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS
        ? "AlreadyExists"
        : createErr.kind === ProvisioningErrorKind.THROTTLED
          ? "Throttled"
          : "Unknown";
    const prefix =
      createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS
        ? "Resource already exists. Re-run 'assignee plan' to refresh."
        : createErr.kind === ProvisioningErrorKind.THROTTLED
          ? "Request throttled by AWS. Please wait and retry."
          : createErr.message;
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `CloudControl provisioning failed: ${prefix}`,
      error: new ProvisioningError(
        createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS
          ? "Resource already exists"
          : createErr.kind === ProvisioningErrorKind.THROTTLED
            ? "Request throttled by AWS"
            : createErr.message,
        errorCategory,
      ),
    };
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
    extras: {
      requestToken: createResult.requestToken,
      resourceType: state.resourceType,
    },
  });

  return {
    requestToken: createResult.requestToken,
    executionStatus: ExecutionStatus.IN_PROGRESS,
    startedAt: Date.now(),
  };
}
