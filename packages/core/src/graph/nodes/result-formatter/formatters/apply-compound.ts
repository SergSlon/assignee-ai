/**
 * Compound pattern apply SUCCESS formatter.
 *
 * Handles two sub-shapes:
 *   1. Mid-compound SUCCESS → advance queue to next resource, reset state.
 *   2. Terminal compound SUCCESS → render summary, write provision records,
 *      check security posture, run post-provision hooks, emit CloudFront URL
 *      for static-website.
 *
 * BARE vs FULL ARN discipline:
 * - completedResources[].resourceArn keeps the bare CCAPI identifier so the
 *   compound marker resolver can substitute it into VpcId/SubnetId fields
 *   that reject full ARNs.
 * - A separate displayArns map (keyed by resourceId) carries the full ARNs
 *   for display, logging, SecurityHub, billing, and the provision record.
 */

import chalk from "chalk";
import type { StructuredTool } from "@langchain/core/tools";
import {
  ExecutionStatus,
  PatternId,
  RESOURCE_TYPES,
  type ResourceResult,
} from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import { renderCompoundSuccess } from "@/utils/display.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { checkSecurityPosture } from "@/utils/security-posture.js";
import {
  writeProvisionRecord,
  clearFailureHistory,
  upsertPatternRecord,
} from "@/utils/memory-recorder.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { getOperatorCallerArn } from "@/utils/resolve-arn.js";
import { attachCompensatingBucketPolicy } from "@/services/s3-compensating-bucket-policy.js";
import { buildDisplayArnMap, resolveDisplayArn } from "../arn-display.js";
import {
  printStaticWebsiteCloudFrontUrl,
  runStaticSiteUploadFor,
} from "./static-site-upload.js";

export async function formatApplyCompoundSuccess(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  // Caller guarantees these are defined.
  const resourceQueue = state.resourceQueue!;
  const currentResourceIndex = state.currentResourceIndex!;
  const pattern = state.resourcePattern!;

  const displayArn = await resolveDisplayArn(
    state.resourceType,
    state.resourceArn,
  );

  const currentResource = resourceQueue[currentResourceIndex];
  if (!currentResource) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Compound resource index ${currentResourceIndex} out of bounds (queue length ${resourceQueue.length})`,
    };
  }

  const completedEntry: ResourceResult = {
    resourceId: currentResource.resourceId,
    resourceType: currentResource.resourceType,
    // BARE CCAPI identifier — must NOT be the full ARN. The next iteration's
    // compound marker resolver substitutes this value into VpcId/SubnetId/IgwId.
    resourceArn: state.resourceArn,
    executionStatus: ExecutionStatus.SUCCESS,
    // Propagate CloudFront DomainName from graph state into metadata so the
    // static-website URL printer can use the real DNS-resolvable hostname
    // instead of constructing a broken <id>.cloudfront.net URL.
    ...(currentResource.resourceType ===
      RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION && state.cloudFrontDomainName
      ? { metadata: { cloudFrontDomainName: state.cloudFrontDomainName } }
      : {}),
  };
  const updatedCompleted = [
    ...(state.completedResources ?? []),
    completedEntry,
  ];
  const nextIndex = currentResourceIndex + 1;

  // ── Mid-compound: advance to next resource ────────────────────────────
  if (nextIndex < resourceQueue.length) {
    const nextResource = resourceQueue[nextIndex];
    if (!nextResource) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Internal error: resource queue corrupted at index ${nextIndex}. ${updatedCompleted.length} of ${resourceQueue.length} resources completed.`,
        completedResources: updatedCompleted,
      };
    }
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.APPLY_SUCCEEDED,
      extras: {
        resourceArn: displayArn,
        resourceType: currentResource.resourceType,
        compound: true,
      },
    });
    return {
      completedResources: updatedCompleted,
      currentResourceIndex: nextIndex,
      resourceType: nextResource.resourceType,
      desiredState: undefined,
      requestToken: undefined,
      resourceArn: undefined,
      executionStatus: ExecutionStatus.PENDING,
      // W11-S0 (M-α-07): reset per-resource throttle budget so resource N+1
      // starts with a full retry window instead of inheriting resource N's
      // exhausted count.  Without this reset, a resource that hit the ceiling
      // (e.g. throttleRetryCount === MAX_THROTTLE_RETRIES) would cause every
      // subsequent resource in the queue to fail immediately on the first
      // ThrottlingException.
      throttleRetryCount: 0,
    };
  }

  // ── Terminal compound SUCCESS ─────────────────────────────────────────
  const displayArns = await buildDisplayArnMap(updatedCompleted);

  renderCompoundSuccess(updatedCompleted, pattern, displayArns);
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.APPLY_SUCCEEDED,
    extras: { compound: true, completedCount: updatedCompleted.length },
  });

  // Bug S3-001 Part 2 — compensating bucket policy for every S3 bucket in the
  // completed set. Attaches a resource-based bucket policy that restores per-
  // bucket tag-scoped destructive access (aws:ResourceTag IS honored in bucket
  // policies, unlike in IAM identity policies for bucket-level operations).
  // Non-blocking: if PutBucketPolicy fails, warn and continue.
  //
  // bug-s3-bucket-policy-attach-failure-observability: this loop now runs
  // BEFORE the provision-record write loop below so we can persist the
  // per-bucket attach outcome (compensatingPolicyAttached + error) on the
  // provision record. `assignee list` reads the field to flag buckets where
  // the per-bucket tag boundary is not in effect.
  //
  // bug-s3-bucket-policy-compound-serialization: replaces the previous
  // sequential `for…await` with a bounded-concurrency runner so a hypothetical
  // pattern with N S3 buckets does not serialise N PutBucketPolicy
  // round-trips. Today no pattern provisions multiple S3 buckets so the
  // observable difference is zero, but the structure is in place if that
  // changes. `Promise.allSettled`-style semantics: every bucket is attempted
  // even if an earlier one fails (no early-exit on rejection).
  const s3BucketResources = updatedCompleted.filter(
    (r) => r.resourceType === RESOURCE_TYPES.S3_BUCKET && r.resourceArn,
  );
  // bug-s3-bucket-policy-attach-failure-observability HIGH-1 fix:
  // key the outcome map by `resourceId` (the resource-instance ID),
  // NOT by `resourceArn`. The compound BARE-vs-FULL-ARN discipline
  // (see the file header at lines 17-22 + the BARE comment at line
  // 70) means `resourceArn` on completed entries is the BARE CCAPI
  // identifier (e.g. `assignee-mybucket-2026`), but the
  // provision-record writer below derives `arnForRecord` via
  // `displayArns[completed.resourceId]` which production resolves
  // to the FULL `arn:aws:s3:::<name>`. Keying by ARN would silently
  // miss every lookup → `compensatingPolicyAttached` never
  // persisted on compound provision records → Story 3 broken.
  // Resource-instance ID is stable across both forms; use it.
  const policyOutcomeByResourceId = new Map<
    string,
    { attached: boolean; reason?: string }
  >();
  if (s3BucketResources.length > 0) {
    const operatorArn = await getOperatorCallerArn();
    if (operatorArn) {
      await runWithBoundedConcurrency(
        S3_POLICY_ATTACH_CONCURRENCY,
        s3BucketResources,
        async (s3Resource) => {
          if (!s3Resource.resourceArn) return;
          const policyResult = await attachCompensatingBucketPolicy({
            bucketName: s3Resource.resourceArn,
            operatorArn,
            region: AWS_REGION,
          });
          if (s3Resource.resourceId) {
            policyOutcomeByResourceId.set(s3Resource.resourceId, {
              attached: policyResult.attached,
              reason: policyResult.reason,
            });
          }
          if (!policyResult.attached) {
            process.stderr.write(
              chalk.yellow(
                `⚠ Compensating bucket policy could not be attached to ${s3Resource.resourceArn}: ${policyResult.reason ?? "unknown error"}\n` +
                  `  The bucket was created successfully but per-bucket tag-scoped destructive access is NOT in effect.\n` +
                  `  Re-run \`assignee setup\` to retry the policy attachment.\n`,
              ),
            );
            log({
              ts: new Date().toISOString(),
              runId: state.runId,
              level: "warn",
              action: LOG_ACTIONS.APPLY_SUCCEEDED,
              extras: {
                compensatingBucketPolicyFailed: true,
                bucketName: s3Resource.resourceArn,
                reason: policyResult.reason,
              },
            });
          }
        },
      );
    } else {
      for (const s3Resource of s3BucketResources) {
        if (!s3Resource.resourceArn) continue;
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.APPLY_SUCCEEDED,
          extras: {
            compensatingBucketPolicySkipped: true,
            bucketName: s3Resource.resourceArn,
            reason: "operator ARN unavailable — STS not called yet",
          },
        });
      }
    }
  }

  // Story 19.3 — provision records (one per resource) with resolved ARNs.
  // bug-s3-bucket-policy-attach-failure-observability: thread the per-bucket
  // policy outcome onto the matching S3 record so `assignee list` can flag
  // buckets where the compensating policy is missing.
  for (const completed of updatedCompleted) {
    const arnForRecord =
      (completed.resourceId && displayArns[completed.resourceId]) ||
      completed.resourceArn;
    // HIGH-1 fix: look up by resourceId (not arnForRecord). See the
    // map declaration above for rationale.
    const policyOutcome = completed.resourceId
      ? policyOutcomeByResourceId.get(completed.resourceId)
      : undefined;
    const extras: Parameters<typeof writeProvisionRecord>[6] = policyOutcome
      ? {
          compensatingPolicyAttached: policyOutcome.attached,
          ...(policyOutcome.reason && !policyOutcome.attached
            ? { compensatingPolicyError: policyOutcome.reason }
            : {}),
        }
      : {};
    // `assignee update` follow-on: when this completed resource is the
    // CloudFront distribution, capture the live DomainName so the
    // future `assignee update <bucket>` resolver can print the URL
    // without an extra GetDistribution. We pull from BOTH places the
    // hostname could be carried: (a) the metadata we already stamped
    // on `completedEntry` for the static-website compound (line
    // ~76-79), and (b) the `state.cloudFrontDomainName` slot the
    // status-poller populates on the active resource. Either is
    // sufficient; we prefer the per-resource value because compounds
    // can carry multiple CloudFront distributions in the future.
    if (completed.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION) {
      const domain =
        completed.metadata?.cloudFrontDomainName ?? state.cloudFrontDomainName;
      if (typeof domain === "string" && domain.length > 0) {
        extras.cloudFrontDomainName = domain;
      }
    }
    await writeProvisionRecord(
      state.runId,
      completed.resourceType,
      arnForRecord,
      undefined,
      state.perResourceCosts?.[completed.resourceId ?? ""],
      undefined,
      Object.keys(extras).length > 0 ? extras : undefined,
    );
  }

  // Story 20.13 — clear stale failure history for each successful type.
  const succeededTypes = new Set(
    updatedCompleted
      .filter((r) => r.executionStatus === ExecutionStatus.SUCCESS)
      .map((r) => r.resourceType),
  );
  for (const resourceType of succeededTypes) {
    await clearFailureHistory(state.runId, resourceType);
  }

  // Story 19.5 — pattern memory.
  await upsertPatternRecord(
    state.runId,
    pattern.patternId,
    state.elicitedOptions ?? {},
  );

  // Story 19.2 — security posture (non-blocking), keyed by full ARN.
  if (tools) {
    for (const resource of updatedCompleted) {
      const arnForCheck =
        (resource.resourceId && displayArns[resource.resourceId]) ||
        resource.resourceArn;
      if (arnForCheck) {
        await checkSecurityPosture(arnForCheck, tools, state.runId);
      }
    }
  }

  // Story 37.4 — static-site upload if --source supplied.
  if (state.sourceDir) {
    const s3Resource = updatedCompleted.find(
      (r) => r.resourceType === RESOURCE_TYPES.S3_BUCKET && r.resourceArn,
    );
    if (s3Resource?.resourceArn) {
      await runStaticSiteUploadFor(s3Resource.resourceArn, state.sourceDir);
    }
  }

  const hasS3InCompleted = updatedCompleted.some(
    (r) => r.resourceType === RESOURCE_TYPES.S3_BUCKET,
  );
  if (state.sourceDir && !hasS3InCompleted) {
    process.stderr.write(
      chalk.yellow(
        `\u26A0 --source flag ignored: file upload only supported for S3 buckets, not ${state.resourceType}\n`,
      ),
    );
  }

  // Task 4b (2026-04-09) — static-website CloudFront URL.
  if (pattern.patternId === PatternId.STATIC_WEBSITE) {
    printStaticWebsiteCloudFrontUrl(updatedCompleted);
  }

  return { completedResources: updatedCompleted };
}

/**
 * bug-s3-bucket-policy-compound-serialization — concurrency cap for the
 * compound S3 PutBucketPolicy attachment loop. 5 mirrors the typical
 * `p-limit(5)` recommendation (a value high enough to avoid latency
 * stacking for hypothetical multi-bucket patterns yet low enough to stay
 * well under the S3 API per-bucket throttle ceiling). Exported for unit
 * testing.
 */
export const S3_POLICY_ATTACH_CONCURRENCY = 5;

/**
 * bug-s3-bucket-policy-compound-serialization — manual semaphore that
 * runs `task(item)` against every item in `items` with at most
 * `concurrency` invocations in flight. Failures are NOT propagated as
 * rejections — the runner wraps each task in a try/catch so a single
 * SDK throw can never abort the rest of the batch. Callers that need
 * the per-task error must handle it inside the `task` body (the existing
 * S3 attach loop already does this via `AttachResult.attached`).
 *
 * Implementation: workers pull from a shared cursor index; when
 * `concurrency >= items.length`, every item runs immediately in
 * parallel (Promise.all-equivalent). Avoids adding a `p-limit` /
 * `p-queue` dependency to keep the bundle small and dependency
 * surface minimal. Exported for unit testing.
 */
export async function runWithBoundedConcurrency<T>(
  concurrency: number,
  items: readonly T[],
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        await task(items[i]!);
      } catch (err) {
        // The S3 attach loop converts SDK errors to AttachResult.attached
        // === false; any throw here is therefore unexpected. Swallow so
        // the rest of the batch still runs — the caller surfaces failures
        // through the per-task observability channel (provision record
        // + stderr warning).
        //
        // L1 fix: emit a structured warning log so future programming
        // errors in `task` are visible. Previously the catch block
        // discarded the error silently, which made any stray throw
        // invisible during dev / debug runs.
        log({
          ts: new Date().toISOString(),
          // L1 fix: helper is run-id-agnostic (caller-neutral
          // utility). Use a sentinel so the LogEvent invariant
          // (`runId: string`) holds without forcing every caller to
          // thread their runId through the helper signature.
          runId: "bounded-concurrency-helper",
          level: "warn",
          action: LOG_ACTIONS.APPLY_SUCCEEDED,
          extras: {
            boundedConcurrencyTaskThrew:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  });
  await Promise.all(workers);
}
