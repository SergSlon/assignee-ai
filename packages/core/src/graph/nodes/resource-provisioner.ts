/**
 * resource_provisioner node — State Guard (FR-15 Read-Before-Write) then CloudControl create.
 * Runs in Phase 2 of apply, after the LangGraph HITL interrupt is resumed.
 *
 * Depends on ProvisioningPort (DIP) — no direct AWS SDK imports in this file.
 *
 * Post Wave-6 F3: the god-function has been decomposed by responsibility
 * into `resource-provisioner/*`. This file is the thin orchestrator that
 * wires pre-hooks → state-guard → CCAPI create → cleanup-on-failure.
 *
 * @see Story 7-6, Story 9-2, docs/stories/wave-6-f3-resource-provisioner-solid.md
 */

import {
  CCAPI_REDIRECT_TYPES,
  ExecutionStatus,
  PROVISIONING_ERROR_CODES,
  ProvisioningError,
} from "../../index.js";
import type { ProvisioningPort } from "../../ports/provisioning-port.js";
import { ProvisioningErrorKind } from "../../ports/provisioning-port.js";
import { injectMandatoryTags } from "../../utils/tags.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import type { AgentState } from "../graph-state.js";

import {
  formatErrorForLog,
  isResourceType,
  sanitizeKeyName,
} from "./resource-provisioner/util.js";
import { safeCloneDesiredState } from "./resource-provisioner/state.js";
import { runStateGuard } from "./resource-provisioner/state-guard.js";
import { allocateNatGatewayEip } from "./resource-provisioner/eip-allocator.js";
import { ensureSshKeypair } from "./resource-provisioner/ssh-keypair.js";
import { cleanupAllocatedResources } from "./resource-provisioner/cleanup.js";
import {
  createResourceWithCloudFrontRetry,
  waitForCloudFrontRetryDnsIfNeeded,
  waitForCloudFrontS3DnsIfNeeded,
} from "./resource-provisioner/ccapi.js";

// Re-export for backwards-compatibility with existing test imports and any
// external callers. DO NOT remove — `resource-provisioner.test.ts` imports
// these by name from "./resource-provisioner.js".
export { sanitizeKeyName, formatErrorForLog };

/**
 * Inline classifier for CCAPI-gap resource types.
 *
 * Story 50-7: replaces the prior `SDKFallbackDispatcher.isRedirect()` —
 * after A10 removed all SDK write paths there were only two redirect
 * entries left (AWS::Lambda::Permission → PermissionPolicy,
 * AWS::ElastiCache::ReplicationGroup → ServerlessCache). A class with
 * two always-false hooks was pure ceremony; the map-lookup is the
 * whole function.
 */
function classifyUnsupported(resourceType: string): {
  redirect: true;
  message: string;
} | null {
  const alternative = CCAPI_REDIRECT_TYPES[resourceType];
  if (!alternative) return null;
  if (resourceType === "AWS::Lambda::Permission") {
    return {
      redirect: true,
      message:
        "AWS::Lambda::Permission is not supported by CCAPI. Use AWS::Lambda::PermissionPolicy instead.",
    };
  }
  if (resourceType === "AWS::ElastiCache::ReplicationGroup") {
    return {
      redirect: true,
      message:
        "ElastiCache ReplicationGroup is not supported. Use AWS::ElastiCache::ServerlessCache for Redis/Memcached.",
    };
  }
  return {
    redirect: true,
    message: `${resourceType} is not supported by CCAPI. Use ${alternative} instead.`,
  };
}

export async function resourceProvisionerNode(
  state: AgentState,
  provisioner: ProvisioningPort,
): Promise<Partial<AgentState>> {
  if (state.executionStatus === ExecutionStatus.CANCELLED) return {};

  // CloudFront S3 retry: wait for DNS propagation before re-creating.
  await waitForCloudFrontRetryDnsIfNeeded(state);

  // Skip non-provisionable resources (companion/post-provision types).
  const currentResource =
    state.resourceQueue?.[state.currentResourceIndex ?? 0];
  if (currentResource?.provisionable === false) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.SDK_FALLBACK_DISPATCHED,
      extras: {
        resourceType: state.resourceType,
        dispatchPath: "companion-skip",
        message: `Skipping non-provisionable resource: ${currentResource.displayName}`,
      },
    });
    return {
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: undefined,
    };
  }

  if (!state.desiredState) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Cannot provision: desiredState is missing.",
    };
  }

  // Item F / H8 / P1-R2-8: deep-clone and enforce the plain-object contract
  // before any mutation. See resource-provisioner/state.ts.
  const cloneResourceId =
    currentResource?.resourceId ??
    currentResource?.displayName ??
    state.resourceType ??
    "unknown";
  const desiredState: Record<string, unknown> = safeCloneDesiredState(
    state.desiredState,
    cloneResourceId,
  );

  // CCAPI-gap redirect (Story 7.7, inlined in Story 50-7) — emit a
  // friendly "use X instead" message before the CCAPI path for the
  // two remaining redirect-only types (Lambda::Permission,
  // ElastiCache::ReplicationGroup). A10 (2026-04-09) removed the
  // last SDK write path, so this is purely a classifier now.
  if (state.resourceType) {
    const redirect = classifyUnsupported(state.resourceType);
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
        error: new ProvisioningError(
          redirect.message,
          PROVISIONING_ERROR_CODES.UNSUPPORTED_TYPE,
        ),
      };
    }
  }

  // Validate resourceType BEFORE any AWS calls.
  if (!state.resourceType || !isResourceType(state.resourceType)) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Cannot provision: unsupported or missing resourceType "${state.resourceType ?? ""}".`,
    };
  }

  // FR-15 Read-Before-Write state guard.
  const guard = await runStateGuard(
    state,
    provisioner,
    state.resourceType,
    desiredState,
  );
  if (guard.abort) return guard.partial;

  // Pre-hook: EIP allocation for NAT Gateway.
  const eipRes = await allocateNatGatewayEip(state, desiredState);
  if (!eipRes.ok) return eipRes.partial;
  const freshlyAllocatedEipIds = eipRes.freshlyAllocated;

  // Pre-hook: SSH key pair for EC2 Instance.
  const sshRes = await ensureSshKeypair(state, desiredState);
  if (!sshRes.ok) {
    // Verify-failed path already logged; clean up any partial side-effects.
    await cleanupAllocatedResources(state, {
      eipReleased: freshlyAllocatedEipIds,
      sshDeleted: sshRes.sshKeyCreatedName,
    });
    return sshRes.partial;
  }
  const sshKeyCreatedName = sshRes.sshKeyCreatedName;

  // Inject mandatory tags (NFR-14).
  const propertiesWithTags = injectMandatoryTags(
    desiredState,
    state.runId,
    state.resourceType,
  );

  // Pre-create: wait for CloudFront S3 bucket DNS if we just created one.
  await waitForCloudFrontS3DnsIfNeeded(state);

  // CloudControl async create (with CloudFront S3-DNS retry budget).
  const { createErr, createResult } = await createResourceWithCloudFrontRetry(
    provisioner,
    state,
    state.resourceType,
    JSON.stringify(propertiesWithTags),
    state.runId,
    state.currentResourceIndex,
  );

  if (createErr) {
    const isBucketAlreadyExists =
      createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS &&
      state.resourceType === "AWS::S3::Bucket";
    const errorCategory =
      createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS
        ? PROVISIONING_ERROR_CODES.ALREADY_EXISTS
        : createErr.kind === ProvisioningErrorKind.THROTTLED
          ? PROVISIONING_ERROR_CODES.THROTTLED
          : PROVISIONING_ERROR_CODES.UNKNOWN;
    const prefix = isBucketAlreadyExists
      ? "S3 bucket name is already taken globally. Choose a different name."
      : createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS
        ? "Resource already exists. Choose a different name."
        : createErr.kind === ProvisioningErrorKind.THROTTLED
          ? "Request throttled by AWS. Please wait and retry."
          : createErr.message;
    await cleanupAllocatedResources(state, {
      eipReleased: freshlyAllocatedEipIds,
      sshDeleted: sshKeyCreatedName,
    });
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
      // H9: ALWAYS surface the cloned desiredState back to the reducer —
      // even on failure — so retries can reuse allocated side-resources.
      desiredState,
    };
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
    extras: {
      requestToken: createResult!.requestToken,
      resourceType: state.resourceType,
    },
  });

  return {
    requestToken: createResult!.requestToken,
    executionStatus: ExecutionStatus.IN_PROGRESS,
    startedAt: Date.now(),
    // Item F: surface the cloned desiredState via the reducer.
    desiredState,
  };
}
