/**
 * status_poller node — polls CloudControl for async operation status.
 * LangGraph self-loop: returns IN_PROGRESS to re-invoke itself, or routes to result_formatter.
 * Timeout: 5 minutes; poll interval: 2 seconds.
 *
 * Depends on ProvisioningPort (DIP) — no direct AWS SDK imports.
 *
 * @see Story 7-6, Story 9-2
 */

import {
  ExecutionStatus,
  RESOURCE_TYPES,
  LIST_RESOURCE_TYPES,
} from "@assignee/core";
import type { ProvisioningPort } from "../services/provisioning-port.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph-state.js";

const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2_000; // 2 seconds

/** Resource types that need extended provisioning timeouts. */
const EXTENDED_TIMEOUT_TYPES: Set<string> = new Set([
  RESOURCE_TYPES.RDS_DB_INSTANCE,
  LIST_RESOURCE_TYPES.RDS_DB_CLUSTER,
  RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
  RESOURCE_TYPES.EC2_NAT_GATEWAY,
  // CloudFront deployments take 10-15 min worldwide
  RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
]);
const EXTENDED_POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes (CloudFront + RDS can hit 15)

// NOTE (H10 fix): A previous "MAX_POLL_ITERATIONS" guard divided wall-clock by
// POLL_INTERVAL_MS to estimate iterations, but each iteration actually waits
// POLL_INTERVAL_MS + AWS RTT, so the counter always under-counted real loops
// and the guard never fired before the wall-clock timeout — it was dead code.
// It has been removed in favor of:
//   1. The resource-type-aware wall-clock timeout below (authoritative).
//   2. The startedAt-required invariant: if startedAt is missing on entry we
//      now FAIL fast (was: silently reset to Date.now(), which made the
//      wall-clock timeout impossible to ever trigger on a corrupted self-loop).
// We deliberately did NOT add an `iterationCount` to AgentState because the
// wall-clock guard combined with the startedAt invariant fully covers the
// runaway-loop class without expanding the shared state schema.

function getPollTimeout(resourceType: string): number {
  return EXTENDED_TIMEOUT_TYPES.has(resourceType)
    ? EXTENDED_POLL_TIMEOUT_MS
    : DEFAULT_POLL_TIMEOUT_MS;
}

const ProvisioningStatus = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCEL_COMPLETE: "CANCEL_COMPLETE",
} as const;

/** Maximum CloudFront S3 origin retry attempts before hard failure. */
const MAX_CLOUDFRONT_RETRIES = 3;

/**
 * Detects transient CloudFront S3 origin DNS propagation failures.
 * These occur when CCAPI's async CloudFront validator can't reach a
 * just-created S3 bucket because global DNS hasn't propagated yet.
 * Returns true only for S3-origin-related failures, NOT for config errors.
 *
 * Exported for unit testing.
 */
export function isRetryableCloudFrontS3Error(statusMessage: string): boolean {
  if (!statusMessage) return false;
  const lower = statusMessage.toLowerCase();
  // CCAPI CloudFront errors for S3 origin validation failure:
  // - "The parameter Origin DomainName does not refer to a valid S3 bucket"
  //   (synchronous 400 — CCAPI wraps it as async FAILED in poll response)
  // - "One or more of your origins ... does not exist"
  // - "The S3 bucket ... does not exist"
  // - "NoSuchBucket"
  // - "InvalidOrigin" (generic origin validation failure)
  return (
    lower.includes("does not refer to a valid s3 bucket") ||
    lower.includes("does not exist") ||
    lower.includes("nosuchbucket") ||
    lower.includes("invalidorigin") ||
    lower.includes("s3 origin") ||
    (lower.includes("origin") && lower.includes("not found")) ||
    (lower.includes("origin") &&
      lower.includes("domainname") &&
      lower.includes("s3"))
  );
}

export async function statusPollerNode(
  state: AgentState,
  provisioner: ProvisioningPort,
): Promise<Partial<AgentState>> {
  if (!state.requestToken) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "No request token to poll. Hint: resource_provisioner may not have run.",
    };
  }

  // H10 fix: startedAt MUST be set by resource_provisioner before this node is
  // ever invoked. If it is missing on entry, the graph state is corrupt
  // (bad reducer, partial state, deserialization quirk, etc.) and we MUST
  // fail fast. Previously this fell back to `Date.now()` on every iteration,
  // which made the wall-clock timeout reset every poll and produced an
  // unkillable infinite poll loop on a self-looping LangGraph node.
  if (state.startedAt === undefined) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "status_poller invoked without startedAt — graph state is corrupt",
    };
  }
  const startedAt: number = state.startedAt;

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PROVISIONING_STATUS_CHECKED,
    extras: {
      phase: "poll_start",
      requestToken: state.requestToken,
      resourceType: state.resourceType,
    },
  });

  // Timeout guard (resource-type-aware) — authoritative runaway-loop guard.
  const timeoutMs = getPollTimeout(state.resourceType ?? "");
  const timeoutMin = Math.round(timeoutMs / 60_000);
  if (Date.now() - startedAt > timeoutMs) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Resource provisioning timed out after ${timeoutMin} minutes. Hint: check the AWS CloudFormation console for resource status.`,
    };
  }

  // Wait between polls
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

  const [pollErr, result] = await provisioner.getRequestStatus(
    state.requestToken,
  );

  if (pollErr) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `CloudControl polling failed: ${pollErr.message}`,
    };
  }

  const status = result.operationStatus;
  const durationMs = Date.now() - startedAt;

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PROVISIONING_STATUS_CHECKED,
    durationMs,
    extras: { status },
  });

  // ── CloudFront S3 retry: transient origin DNS propagation failure ──────
  // CCAPI CloudFront::Distribution creation may fail asynchronously when the
  // S3 origin bucket was just created in the same compound — the bucket
  // exists but its global DNS hasn't propagated to CloudFront's validation
  // backend yet. This is a known AWS timing issue, not a configuration
  // error. Signal a retry by staying IN_PROGRESS with a cleared
  // requestToken (the router detects this and sends us back to
  // resource_provisioner, which waits 30s then re-creates).
  if (
    status === ProvisioningStatus.FAILED &&
    state.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION &&
    isRetryableCloudFrontS3Error(
      typeof result.statusMessage === "string" ? result.statusMessage : "",
    ) &&
    (state.retryCount ?? 0) < MAX_CLOUDFRONT_RETRIES
  ) {
    const newRetryCount = (state.retryCount ?? 0) + 1;
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "warn",
      action: LOG_ACTIONS.PROVISIONING_STATUS_CHECKED,
      durationMs,
      extras: {
        status,
        retryCount: newRetryCount,
        message: `CloudFront S3 origin DNS propagation failure — retrying (${newRetryCount}/${MAX_CLOUDFRONT_RETRIES})`,
        originalError: result.statusMessage,
      },
    });
    return {
      executionStatus: ExecutionStatus.IN_PROGRESS,
      retryCount: newRetryCount,
      requestToken: undefined, // clear stale token to signal retry
    };
  }

  if (
    status === ProvisioningStatus.FAILED ||
    status === ProvisioningStatus.CANCEL_COMPLETE
  ) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        typeof result.statusMessage === "string"
          ? result.statusMessage
          : "Resource provisioning failed.",
    };
  }

  if (status === ProvisioningStatus.SUCCESS) {
    return {
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: result.identifier,
    };
  }

  // Still IN_PROGRESS — LangGraph self-loop will re-invoke this node
  return { executionStatus: ExecutionStatus.IN_PROGRESS };
}
