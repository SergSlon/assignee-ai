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
  CCAPI_FALLBACK_TYPES,
  type ResourceType,
  ProvisioningError,
} from "@assignee/core";
import type { ProvisioningPort } from "../services/provisioning-port.js";
import { ProvisioningErrorKind } from "../services/provisioning-port.js";
import type { SDKFallbackDispatcher } from "../services/sdk-fallback-dispatcher.js";
import { injectMandatoryTags } from "../utils/tags.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph-state.js";

function isResourceType(s: string): s is ResourceType {
  return (SUPPORTED_TYPES_ARRAY as readonly string[]).includes(s);
}

export async function resourceProvisionerNode(
  state: AgentState,
  provisioner: ProvisioningPort,
  fallbackDispatcher?: SDKFallbackDispatcher,
): Promise<Partial<AgentState>> {
  if (state.executionStatus === ExecutionStatus.CANCELLED) return {};

  if (!state.desiredState) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Cannot provision: desiredState is missing.",
    };
  }

  // ── SDK Fallback Dispatch (Story 7.7) ────────────────────────────────────
  // Check for CCAPI gap types BEFORE the CloudControl path.
  if (state.resourceType && fallbackDispatcher) {
    // Check redirect types first (unsupported with known alternative)
    const redirect = fallbackDispatcher.isRedirect(state.resourceType);
    if (redirect) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.SDK_FALLBACK_DISPATCHED,
        extras: {
          resourceType: state.resourceType,
          dispatchPath: "redirect",
          message: redirect.message,
        },
      });
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: redirect.message,
        error: new ProvisioningError(redirect.message, "UnsupportedType"),
      };
    }

    // Check SDK-routable types (can be provisioned via native SDK)
    if (fallbackDispatcher.canHandle(state.resourceType)) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.SDK_FALLBACK_DISPATCHED,
        extras: {
          resourceType: state.resourceType,
          dispatchPath: "sdk_fallback",
        },
      });

      // Inject tags for EventSourceMapping (supports Tags parameter)
      // SNS Subscriptions do NOT support tags at creation time
      const desiredStateForSdk =
        state.resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING
          ? injectMandatoryTags(
              state.desiredState,
              state.runId,
              state.resourceType,
            )
          : state.desiredState;

      if (
        state.resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING
      ) {
        const [err, result] =
          await fallbackDispatcher.createEventSourceMapping(desiredStateForSdk);
        if (err) {
          return {
            executionStatus: ExecutionStatus.FAILED,
            errorMessage: `SDK fallback provisioning failed: ${err.message}`,
            error: new ProvisioningError(err.message, "Unknown"),
          };
        }
        return {
          executionStatus: ExecutionStatus.SUCCESS,
          resourceArn: result.identifier,
        };
      }

      if (state.resourceType === CCAPI_FALLBACK_TYPES.SNS_SUBSCRIPTION) {
        const [err, result] = await fallbackDispatcher.subscribe(
          state.desiredState,
        );
        if (err) {
          return {
            executionStatus: ExecutionStatus.FAILED,
            errorMessage: `SDK fallback provisioning failed: ${err.message}`,
            error: new ProvisioningError(err.message, "Unknown"),
          };
        }
        return {
          executionStatus: ExecutionStatus.SUCCESS,
          resourceArn: result.identifier,
        };
      }
    }
  }

  // ── State Guard (FR-15 Read-Before-Write) ────────────────────────────────
  if (!state.resourceType || !isResourceType(state.resourceType)) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Cannot provision: unsupported or missing resourceType "${state.resourceType ?? ""}".`,
    };
  }

  // S3 bucket names are globally unique across ALL AWS accounts. CloudControl
  // GetResource may return success for a bucket owned by a *different* account
  // (the name is reserved globally), causing a false "already exists" block.
  // Skip the state guard for S3 — the CreateResource call itself will correctly
  // return ALREADY_EXISTS if the name is genuinely taken.
  const skipStateGuard = state.resourceType === "AWS::S3::Bucket";

  const identifier = skipStateGuard
    ? undefined
    : getPrimaryIdentifier(state.resourceType, state.desiredState);

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
        errorMessage: `Resource already exists (${identifier}). Choose a different name and re-run 'assignee plan'.`,
        error: new ProvisioningError(
          `Resource already exists (${identifier}). Choose a different name`,
          "StateMismatch",
        ),
      };
    }

    if (stateGuardErr.kind !== ProvisioningErrorKind.NOT_FOUND) {
      // Permission or identifier-format errors should not block CREATE — the resource
      // likely doesn't exist, we just can't verify. Log a warning and proceed.
      // This handles: ACCESS_DENIED, invalid identifier formats (SecretsManager Name vs ARN,
      // Route composite identifiers), and other transient GetResource failures.
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
        extras: { reason: stateGuardErr.kind, message: stateGuardErr.message },
      });
      // Fall through to proceed with creation
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
  // Compound patterns reuse runId across resources — append index for unique ClientToken
  const clientToken =
    state.currentResourceIndex != null && state.currentResourceIndex > 0
      ? `${state.runId}-${state.currentResourceIndex}`
      : state.runId;

  const [createErr, createResult] = await provisioner.createResource(
    state.resourceType,
    JSON.stringify(propertiesWithTags),
    clientToken,
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
