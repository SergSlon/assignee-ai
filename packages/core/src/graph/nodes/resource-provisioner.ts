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
import type {
  ProvisioningPort,
  ProvisioningPortError,
} from "../../ports/provisioning-port.js";
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
import { classifyCreateError } from "./resource-provisioner/error-classifier.js";

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

/**
 * Log and short-circuit for non-provisionable (companion/post-provision)
 * resources. Returns the SUCCESS partial when the current resource is
 * flagged `provisionable: false`; otherwise `null` so the caller
 * continues with the normal CCAPI pipeline.
 */
function skipIfCompanionResource(
  state: AgentState,
  currentResource:
    | { provisionable?: boolean; displayName?: string }
    | undefined,
): Partial<AgentState> | null {
  if (currentResource?.provisionable !== false) return null;
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

/**
 * If `resourceType` is a CCAPI-gap redirect (Lambda::Permission,
 * ElastiCache::ReplicationGroup, …), emit a structured warn-log and
 * return the FAILED reducer partial. Otherwise return `null` and let
 * the caller proceed to the standard CCAPI path.
 *
 * Extracted from the main orchestrator body so the happy-path read is
 * a linear pipeline (state-guard → pre-hooks → CCAPI → result) rather
 * than an inline 25-line block.
 */
function checkUnsupportedRedirect(
  state: AgentState,
): Partial<AgentState> | null {
  if (!state.resourceType) return null;
  const redirect = classifyUnsupported(state.resourceType);
  if (!redirect) return null;

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

/**
 * Context passed to `handleCreateError` — gathered at the call site so the
 * helper stays pure (no scope-closure side-effects on reducer state).
 */
interface CreateErrorCtx {
  readonly state: AgentState;
  readonly createErr: ProvisioningPortError;
  readonly desiredState: Record<string, unknown>;
  readonly freshlyAllocatedEipIds: Set<string>;
  readonly sshKeyCreatedName: string | undefined;
}

/**
 * Build the FAILED reducer partial for a CCAPI `createResource` error.
 *
 * Single-source-of-truth for the three axes (userPrefix, errorCode,
 * shortMessage) — they all come from `classifyCreateError` instead of
 * being re-computed from `createErr.kind` by three parallel nested
 * ternaries (the pre-53-it1-12 shape).
 *
 * Side-effect: invokes `cleanupAllocatedResources` to release EIPs /
 * delete SSH key pairs that were allocated before the CCAPI call failed.
 *
 * Invariant: always surfaces the cloned `desiredState` back to the
 * reducer (H9) so retry paths can reuse allocated side-resources.
 */
async function handleCreateError(
  ctx: CreateErrorCtx,
): Promise<Partial<AgentState>> {
  const { state, createErr, desiredState } = ctx;
  const classified = classifyCreateError(createErr, state.resourceType);

  await cleanupAllocatedResources(state, {
    eipReleased: ctx.freshlyAllocatedEipIds,
    sshDeleted: ctx.sshKeyCreatedName,
  });

  return {
    executionStatus: ExecutionStatus.FAILED,
    errorMessage: `CloudControl provisioning failed: ${classified.userPrefix}`,
    error: new ProvisioningError(classified.shortMessage, classified.errorCode),
    // H9: ALWAYS surface the cloned desiredState back to the reducer —
    // even on failure — so retries can reuse allocated side-resources.
    desiredState,
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
  const skip = skipIfCompanionResource(state, currentResource);
  if (skip) return skip;

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
  const redirectPartial = checkUnsupportedRedirect(state);
  if (redirectPartial) return redirectPartial;

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
    return handleCreateError({
      state,
      createErr,
      desiredState,
      freshlyAllocatedEipIds,
      sshKeyCreatedName,
    });
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
