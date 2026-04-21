/**
 * Build graph initial state from a loaded checkpoint.
 *
 * Preserves the original runId for audit trail continuity.
 *
 * Story 41.3: Re-evaluates BP rules against the checkpoint's desiredState
 * to catch rules added/modified after the original plan was generated.
 * Blocking findings update preflightPassed; findings are injected into
 * graph state so preflight_guard and result_formatter can display them.
 *
 * Story e92.1.d-followup (Epic 89 C-05 closure): when the loaded
 * checkpoint carries a non-default `currentResourceIndex` +
 * `completedResources`, hydrate both fields into the graph initial
 * state so plan-generator / resource-provisioner re-enter the
 * compound loop at the right index instead of re-planning already-
 * provisioned resources. The on-disk checkpoint persists only
 * `{resourceArn, resourceType}` per completed entry (intentionally
 * small), but the graph state channel is typed `ResourceResult[]`
 * — which the marker-resolver keys off `.resourceId`. We recover
 * `resourceId` by zipping the persisted entries against the matching
 * prefix of `resourceQueue` (the serializer persists completions in
 * queue order, so indices 0..N-1 of the queue correspond 1:1 to the
 * N persisted completions). Pre-Epic-92 / single-resource
 * checkpoints keep the same initial-state shape they've always had.
 */

import {
  ExecutionMode,
  ExecutionStatus,
  BPEnforcementLevel,
  type ResourceResult,
} from "@assignee/core";
import type { PlanCheckpoint } from "@assignee/core";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { reEvaluateBP } from "../../utils/bp-reeval.js";
import type { UserConfig } from "../../config/user-config-loader.js";

/**
 * Hydrate a `ResourceResult[]` from the checkpoint's compact
 * `{resourceArn, resourceType}[]` + the full `resourceQueue`.
 *
 * The serializer guarantees `completedResources[i]` corresponds to
 * `resourceQueue[i]` for `i < currentResourceIndex` (see
 * `packages/core/src/checkpoint/serializer.ts`). We use that 1:1
 * ordering to recover the logical `resourceId`, which the marker-
 * resolver needs to look up cross-resource references on resume
 * (`match.resourceId === parsed.resourceId`, see
 * `plan-generator/marker-resolver.ts`). `executionStatus: SUCCESS`
 * is tautological — a persisted `completedResource` has a real ARN,
 * which the serializer only writes after provisioning succeeds.
 */
function hydrateCompletedResources(
  checkpoint: PlanCheckpoint,
): ResourceResult[] {
  const completed = checkpoint.completedResources;
  const queue = checkpoint.resourceQueue ?? [];
  return completed.map((entry, index) => {
    const queueEntry = queue[index];
    return {
      // Fall back to the persisted resourceType when the queue is
      // out-of-sync (defence in depth — should not happen with
      // matching serializer/loader versions).
      resourceId: queueEntry?.resourceId ?? entry.resourceType,
      resourceType: entry.resourceType,
      resourceArn: entry.resourceArn,
      executionStatus: ExecutionStatus.SUCCESS,
    };
  });
}

/**
 * Returns `true` when the checkpoint carries a non-default resume
 * position — i.e. the compound loop has already provisioned at least
 * one resource. Pre-Epic-92 / single-resource / fresh-plan
 * checkpoints (index `0`, no completions) return `false` so the
 * graph state stays byte-for-byte identical to the pre-fix shape.
 */
function hasResumeProgress(checkpoint: PlanCheckpoint): boolean {
  return (
    checkpoint.currentResourceIndex > 0 &&
    checkpoint.completedResources.length > 0
  );
}

export function buildCheckpointState(
  checkpoint: PlanCheckpoint,
  opts: { yes?: boolean },
  userConfig: UserConfig | undefined,
  orgConfig: unknown,
): Record<string, unknown> {
  const bpLevel =
    userConfig?.bestPractices?.enforcement ?? BPEnforcementLevel.ENFORCE;

  // Story e92.1.d-followup: conditional resume-state payload —
  // present only when the checkpoint has advanced past index 0 with
  // at least one completed resource. Defined once here so both the
  // BP-fail early-return and the happy-path return spread the same
  // shape into the graph state.
  const resumeProgress = hasResumeProgress(checkpoint)
    ? {
        currentResourceIndex: checkpoint.currentResourceIndex,
        completedResources: hydrateCompletedResources(checkpoint),
      }
    : {};

  // Story 41.3: BP re-evaluation for checkpoint resume
  let bpFindings: ReturnType<typeof reEvaluateBP>["findings"] | undefined;
  let preflightPassed = checkpoint.preflightPassed;

  if (bpLevel !== BPEnforcementLevel.SKIP) {
    let reEval: ReturnType<typeof reEvaluateBP>;
    try {
      reEval = reEvaluateBP({
        resourceType: checkpoint.resourceType,
        desiredState: checkpoint.desiredState,
        userIntent: checkpoint.userIntent,
        patternId: checkpoint.resourcePatternId ?? undefined,
      });
    } catch {
      // BP evaluation failure in enforce mode must be fail-closed
      if (bpLevel === BPEnforcementLevel.ENFORCE) {
        preflightPassed = false;
      }
      return {
        checkpointResumed: true,
        userIntent: checkpoint.userIntent,
        runId: checkpoint.runId,
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        projectDir: process.cwd(),
        resourceType: checkpoint.resourceType,
        desiredState: checkpoint.desiredState,
        estimatedMonthlyCost: checkpoint.estimatedMonthlyCost,
        preflightPassed,
        elicitedOptions: checkpoint.elicitedOptions,
        resourceQueue: checkpoint.resourceQueue,
        bpEnforcementLevel: bpLevel,
        errorMessage:
          "BP evaluation failed — cannot verify security compliance. Re-run plan to regenerate.",
        executionStatus:
          bpLevel === BPEnforcementLevel.ENFORCE
            ? ExecutionStatus.FAILED
            : undefined,
        ...resumeProgress,
        ...(opts.yes ? { autoApprove: true } : {}),
        ...(userConfig ? { userConfig } : {}),
        ...(orgConfig ? { orgConfig } : {}),
      };
    }

    if (reEval.findings.length > 0) {
      bpFindings = reEval.findings;

      if (bpLevel === BPEnforcementLevel.ENFORCE && reEval.hasBlocking) {
        preflightPassed = false;
        log({
          ts: new Date().toISOString(),
          runId: checkpoint.runId,
          level: "warn",
          action: LOG_ACTIONS.BP_EVALUATED,
          extras: {
            context: "checkpoint_resume",
            enforcement: BPEnforcementLevel.ENFORCE,
            blocked: true,
            blockingCount: reEval.blockingFindings.length,
            practiceIds: reEval.blockingFindings.map((f) => f.practiceId),
          },
        });
      } else if (bpLevel === BPEnforcementLevel.WARN && reEval.hasBlocking) {
        log({
          ts: new Date().toISOString(),
          runId: checkpoint.runId,
          level: "warn",
          action: LOG_ACTIONS.BP_EVALUATED,
          extras: {
            context: "checkpoint_resume",
            enforcement: BPEnforcementLevel.WARN,
            blockingCount: reEval.blockingFindings.length,
            practiceIds: reEval.blockingFindings.map((f) => f.practiceId),
          },
        });
      }
    }
  }

  return {
    checkpointResumed: true,
    userIntent: checkpoint.userIntent,
    runId: checkpoint.runId,
    executionMode: ExecutionMode.APPLY,
    startedAt: Date.now(),
    projectDir: process.cwd(),
    resourceType: checkpoint.resourceType,
    desiredState: checkpoint.desiredState,
    estimatedMonthlyCost: checkpoint.estimatedMonthlyCost,
    preflightPassed,
    elicitedOptions: checkpoint.elicitedOptions,
    resourceQueue: checkpoint.resourceQueue,
    bpEnforcementLevel: bpLevel,
    ...resumeProgress,
    ...(bpFindings ? { bpFindings } : {}),
    ...(opts.yes ? { autoApprove: true } : {}),
    ...(userConfig ? { userConfig } : {}),
    ...(orgConfig ? { orgConfig } : {}),
  };
}
