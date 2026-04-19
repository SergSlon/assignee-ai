/**
 * CloudControl create orchestration.
 *
 * Responsibilities:
 *   - Synthesize a ClientToken that is unique per (runId, resourceIndex, attempt).
 *     H11: consecutive retries on the same (runId, index) MUST produce
 *     different tokens or CloudControl returns the cached prior failure
 *     forever and the user can't retry without abandoning the runId.
 *     V1 N1: 12 hex chars = 48 bits of entropy (collision boundary ~16.7M).
 *   - Call `provisioner.createResource` once.
 *   - CloudFront-specific retry budget: when the failure message is the
 *     transient "does not refer to a valid S3 bucket" (S3 global DNS has
 *     not yet propagated for a bucket created seconds ago in the same
 *     compound plan), retry with backoff 5s / 10s / 20s.
 *
 * SRP: this module changes when CCAPI create-call mechanics change.
 */

import { RESOURCE_TYPES, type ResourceType } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import type {
  ProvisioningPort,
  ProvisioningPortError,
  CreateResourceResult,
} from "@/ports/provisioning-port.js";

/** CloudFront S3 origin DNS retry budget (ms). */
const CLOUDFRONT_S3_DNS_RETRY_DELAYS_MS = [5000, 10000, 20000] as const;

/** CloudFront Distribution initial S3 DNS propagation delay (ms). */
const CLOUDFRONT_S3_INITIAL_DNS_DELAY_MS = 30_000;

async function randomAttemptSuffix(): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Compute a ClientToken for a CreateResource call.
 * Exported for unit testing.
 */
export async function buildClientToken(
  runId: string,
  currentResourceIndex: number | undefined,
): Promise<string> {
  const suffix = await randomAttemptSuffix();
  const indexSuffix =
    currentResourceIndex != null && currentResourceIndex > 0
      ? `-${currentResourceIndex}`
      : "";
  return `${runId}${indexSuffix}-${suffix}`;
}

/**
 * Pre-create hook: for CloudFront Distribution in a compound plan that
 * includes an S3 bucket, wait 30s for S3 DNS propagation before calling
 * CreateResource. CCAPI validates the S3 DomainName asynchronously during
 * poll (not synchronously on create) so a post-create retry doesn't help.
 */
export async function waitForCloudFrontS3DnsIfNeeded(
  state: AgentState,
): Promise<void> {
  if (
    state.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION &&
    state.completedResources?.some(
      (r) => r.resourceType === RESOURCE_TYPES.S3_BUCKET,
    )
  ) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PROVISIONING_STATUS_CHECKED,
      extras: {
        phase: "cloudfront_s3_dns_wait",
        delay: CLOUDFRONT_S3_INITIAL_DNS_DELAY_MS,
      },
    });
    await new Promise((r) => setTimeout(r, CLOUDFRONT_S3_INITIAL_DNS_DELAY_MS));
  }
}

/**
 * CloudFront S3-retry entry-point: waits 30s before retrying when CCAPI
 * clears the requestToken on a CloudFront S3-DNS-propagation failure.
 * Returns true when a wait was performed.
 */
export const CLOUDFRONT_S3_RETRY_WAIT_MS = 30_000;
export async function waitForCloudFrontRetryDnsIfNeeded(
  state: AgentState,
): Promise<boolean> {
  if (
    (state.retryCount ?? 0) > 0 &&
    state.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION &&
    !state.requestToken
  ) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
      extras: {
        phase: "cloudfront_s3_retry_wait",
        retryCount: state.retryCount,
        delayMs: CLOUDFRONT_S3_RETRY_WAIT_MS,
        message: `Waiting ${CLOUDFRONT_S3_RETRY_WAIT_MS / 1000}s for S3 DNS propagation before retry ${state.retryCount}/3`,
      },
    });
    await new Promise<void>((resolve) =>
      setTimeout(resolve, CLOUDFRONT_S3_RETRY_WAIT_MS),
    );
    return true;
  }
  return false;
}

export interface CreateResourceOutcome {
  createErr: ProvisioningPortError | null;
  createResult: CreateResourceResult | null;
}

/**
 * Call `provisioner.createResource` with CloudFront S3-DNS retries.
 * Pure orchestration — no state mutation, no cleanup.
 */
export async function createResourceWithCloudFrontRetry(
  provisioner: ProvisioningPort,
  state: AgentState,
  resourceType: ResourceType,
  propertiesJson: string,
  runId: string,
  currentResourceIndex: number | undefined,
): Promise<CreateResourceOutcome> {
  const clientToken = await buildClientToken(runId, currentResourceIndex);
  let [createErr, createResult] = await provisioner.createResource(
    resourceType,
    propertiesJson,
    clientToken,
  );

  if (
    createErr &&
    state.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION &&
    createErr.message?.includes("does not refer to a valid S3 bucket")
  ) {
    for (const delay of CLOUDFRONT_S3_DNS_RETRY_DELAYS_MS) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.PROVISIONING_STATUS_CHECKED,
        extras: {
          phase: "cloudfront_s3_dns_retry",
          delay,
          attempt: CLOUDFRONT_S3_DNS_RETRY_DELAYS_MS.indexOf(delay) + 1,
        },
      });
      await new Promise((r) => setTimeout(r, delay));
      const retryToken = await buildClientToken(runId, currentResourceIndex);
      [createErr, createResult] = await provisioner.createResource(
        resourceType,
        propertiesJson,
        retryToken,
      );
      if (!createErr) break;
      if (!createErr.message?.includes("does not refer to a valid S3 bucket"))
        break;
    }
  }

  return { createErr, createResult };
}
