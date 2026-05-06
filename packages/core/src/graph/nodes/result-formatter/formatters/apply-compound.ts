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

  // Story 19.3 — provision records (one per resource) with resolved ARNs.
  for (const completed of updatedCompleted) {
    const arnForRecord =
      (completed.resourceId && displayArns[completed.resourceId]) ||
      completed.resourceArn;
    await writeProvisionRecord(
      state.runId,
      completed.resourceType,
      arnForRecord,
      undefined,
      state.perResourceCosts?.[completed.resourceId ?? ""],
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
