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
 * Story 56-it2-03a (closes L7-003 MED) relocated the last 3 in-file
 * sibling helpers out to `resource-provisioner/{companion-skip,
 * redirect-guard, create-error-handler}.ts` so this file is purely
 * orchestration glue.
 *
 * @see Story 7-6, Story 9-2, docs/stories/wave-6-f3-resource-provisioner-solid.md
 */

import { ExecutionStatus } from "../../index.js";
import type { ProvisioningPort } from "../../ports/provisioning-port.js";
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
import {
  ensureSshIamProfile,
  type SshIamCreated,
} from "./resource-provisioner/ssh-iam.js";
import { ensureSubnet } from "./resource-provisioner/subnet.js";
import { ensureS3DefaultKms } from "./resource-provisioner/s3-encryption.js";
import { ensureSqsDefaultKms } from "./resource-provisioner/sqs-encryption.js";
import { ensureSnsDefaultKms } from "./resource-provisioner/sns-encryption.js";
import { cleanupAllocatedResources } from "./resource-provisioner/cleanup.js";
import {
  createResourceWithCloudFrontRetry,
  waitForCloudFrontRetryDnsIfNeeded,
  waitForCloudFrontS3DnsIfNeeded,
} from "./resource-provisioner/ccapi.js";
import { skipIfCompanionResource } from "./resource-provisioner/companion-skip.js";
import { checkUnsupportedRedirect } from "./resource-provisioner/redirect-guard.js";
import { handleCreateError } from "./resource-provisioner/create-error-handler.js";
import { routeProvisioningByPartition } from "../../provisioning/partition-aware-provisioner.js";

// Re-export for backwards-compatibility with existing test imports and any
// external callers. DO NOT remove — `resource-provisioner.test.ts` imports
// these by name from "./resource-provisioner.js".
export { sanitizeKeyName, formatErrorForLog };

// SSH-bundle IAM teardown — Pre-demo audit (2026-05-05) H3: post-destroy
// cleanup for the auto-created `assignee-ssh-<runId-suffix>` role +
// instance profile so destroying an EC2 doesn't leave them orphaned.
// Re-exported here so apps/cli can reach the helpers via the
// graph-nodes barrel (the @assignee/core public surface) without
// pulling in the internal sub-path.
export {
  computeSshBundleIamNames,
  destroySshBundleIam,
  maybeDestroySshBundleIamForArn,
  type SshIamDestroyResult,
} from "./resource-provisioner/ssh-iam-destroy.js";

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
  // ElastiCache::ReplicationGroup).
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

  // Pre-hook: SSH-bundle IAM instance profile (auto-attaches the AWS-managed
  // AmazonSSMManagedInstanceCore policy so the instance is SSM-reachable
  // even when SSH is firewalled). No-op for non-SSH-intent applies.
  const iamRes = await ensureSshIamProfile(state, desiredState);
  if (!iamRes.ok) {
    await cleanupAllocatedResources(state, {
      eipReleased: freshlyAllocatedEipIds,
      sshDeleted: sshKeyCreatedName,
      sshIamCreated: iamRes.created,
    });
    return iamRes.partial;
  }
  const sshIamCreated: SshIamCreated = iamRes.created;

  // Pre-hook: resolve SUBNET_PLACEHOLDER to the default VPC's first subnet.
  const subnetRes = await ensureSubnet(state, desiredState);
  if (!subnetRes.ok) {
    await cleanupAllocatedResources(state, {
      eipReleased: freshlyAllocatedEipIds,
      sshDeleted: sshKeyCreatedName,
      sshIamCreated,
    });
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: subnetRes.errorMessage,
      desiredState,
    };
  }

  // Pre-hook: substitute the default Assignee-managed CMK ARN into any
  // S3 SSE-KMS rule that lacks an explicit KMSMasterKeyID (Wave D-1,
  // epic-104). No-op for non-S3 resources or when the user supplied an
  // explicit key. Fails closed on resolver errors so we never silently
  // fall back to AWS-managed keys.
  const s3KmsRes = await ensureS3DefaultKms(state, desiredState);
  if (!s3KmsRes.ok) {
    await cleanupAllocatedResources(state, {
      eipReleased: freshlyAllocatedEipIds,
      sshDeleted: sshKeyCreatedName,
      sshIamCreated,
    });
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: s3KmsRes.errorMessage,
      desiredState,
    };
  }

  // Pre-hook: substitute the default Assignee-managed CMK alias-name
  // into any SQS queue desiredState that lacks an explicit
  // KmsMasterKeyId (Wave D-2, epic-104). Threads `result.aliasName`
  // (NOT keyArn) because SQS accepts alias-form. No-op for non-SQS
  // resources or when the user supplied an explicit key. Fails closed
  // on resolver errors so we never silently fall back to AWS-managed
  // alias/aws/sqs.
  const sqsKmsRes = await ensureSqsDefaultKms(state, desiredState);
  if (!sqsKmsRes.ok) {
    await cleanupAllocatedResources(state, {
      eipReleased: freshlyAllocatedEipIds,
      sshDeleted: sshKeyCreatedName,
      sshIamCreated,
    });
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: sqsKmsRes.errorMessage,
      desiredState,
    };
  }

  // Pre-hook: substitute the default Assignee-managed CMK alias-name
  // into any SNS topic desiredState whose `KmsMasterKeyId` is missing,
  // blank, or equals the AWS-managed sentinel `alias/aws/sns` (the
  // SNS plugin's default — see sns-topic.ts:162). Threads
  // `result.aliasName` (NOT keyArn) because SNS accepts alias-form.
  // No-op for non-SNS resources or when the operator supplied an
  // explicit non-sentinel value (CMK ARN, custom alias, or the
  // alias-ARN escape hatch `arn:aws:kms:<r>:<a>:alias/aws/sns`).
  // Fails closed on resolver errors so we never silently fall back to
  // AWS-managed alias/aws/sns. (Wave D-3, epic-104.)
  const snsKmsRes = await ensureSnsDefaultKms(state, desiredState);
  if (!snsKmsRes.ok) {
    await cleanupAllocatedResources(state, {
      eipReleased: freshlyAllocatedEipIds,
      sshDeleted: sshKeyCreatedName,
      sshIamCreated,
    });
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: snsKmsRes.errorMessage,
      desiredState,
    };
  }

  // Inject mandatory tags (NFR-14).
  const propertiesWithTags = injectMandatoryTags(
    desiredState,
    state.runId,
    state.resourceType,
  );

  // Pre-create: wait for CloudFront S3 bucket DNS if we just created one.
  await waitForCloudFrontS3DnsIfNeeded(state);

  // W5-04 (P055 → L5-S08): check partition × resource-type support matrix.
  // For non-commercial partitions (aws-cn, aws-us-gov, aws-iso, aws-iso-e)
  // where CCAPI does not support the resource type, route to SDK-direct
  // fallback (S3/IAM/VPC) or surface an actionable error.
  // Commercial (`aws`) partition is a no-op passthrough — zero behaviour change.
  let partitionRouteResult;
  try {
    partitionRouteResult = await routeProvisioningByPartition(
      state.resourceType,
      JSON.stringify(propertiesWithTags),
    );
  } catch (routeErr) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        routeErr instanceof Error
          ? routeErr.message
          : `Partition routing failed: ${String(routeErr)}`,
    };
  }

  if (partitionRouteResult.handled) {
    // SDK-direct path succeeded synchronously. Transition directly to SUCCESS
    // so the graph routes to result_formatter without entering status_poller.
    // (CCAPI's async token flow is bypassed — SDK-direct calls are synchronous.)
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
      extras: {
        resourceType: state.resourceType,
        path: "sdk-direct-fallback",
        identifier: partitionRouteResult.identifier,
      },
    });
    return {
      resourceArn: partitionRouteResult.identifier,
      executionStatus: ExecutionStatus.SUCCESS,
      startedAt: Date.now(),
      desiredState,
    };
  }

  // CCAPI path — commercial partition or CCAPI-supported non-commercial type.
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
      sshIamCreated,
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
