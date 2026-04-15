/**
 * Build graph initial state from a loaded checkpoint.
 *
 * Preserves the original runId for audit trail continuity.
 *
 * Story 41.3: Re-evaluates BP rules against the checkpoint's desiredState
 * to catch rules added/modified after the original plan was generated.
 * Blocking findings update preflightPassed; findings are injected into
 * graph state so preflight_guard and result_formatter can display them.
 */

import {
  ExecutionMode,
  ExecutionStatus,
  BPEnforcementLevel,
} from "@assignee/core";
import type { PlanCheckpoint } from "@assignee/core";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { reEvaluateBP } from "../../utils/bp-reeval.js";
import type { UserConfig } from "../../config/user-config-loader.js";

export function buildCheckpointState(
  checkpoint: PlanCheckpoint,
  opts: { yes?: boolean },
  userConfig: UserConfig | undefined,
  orgConfig: unknown,
): Record<string, unknown> {
  const bpLevel =
    userConfig?.bestPractices?.enforcement ?? BPEnforcementLevel.ENFORCE;

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
    ...(bpFindings ? { bpFindings } : {}),
    ...(opts.yes ? { autoApprove: true } : {}),
    ...(userConfig ? { userConfig } : {}),
    ...(orgConfig ? { orgConfig } : {}),
  };
}
