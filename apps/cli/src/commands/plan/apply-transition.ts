/**
 * Plan → apply transition: re-invokes the graph in APPLY mode, routes
 * through the human-approval HITL gate, then drives the provisioning
 * loop.
 *
 * Wave-6d F4: split out of plan.ts.
 */
import {
  BPEnforcementLevel,
  ExecutionMode,
  ExecutionStatus,
} from "@assignee/core";
import type { AgentState } from "../../services/graph-state.js";
import type { CommandContext } from "../../utils/command-runner.js";
import { runProvisioningLoop } from "../../utils/command-runner.js";
import { renderError, startSpinner, stopSpinner } from "../../utils/display.js";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import type { UserConfig } from "../../config/user-config-loader.js";

export interface ApplyTransitionDeps {
  ctx: CommandContext;
  planState: AgentState;
  userConfig: UserConfig | null | undefined;
}

/**
 * Returns final { success } for the whole plan-to-apply flow.
 */
export async function runPlanToApply(
  deps: ApplyTransitionDeps,
): Promise<{ success: boolean }> {
  const { ctx, planState, userConfig } = deps;
  log({
    ts: new Date().toISOString(),
    runId: ctx.runId,
    level: "info",
    action: LOG_ACTIONS.PLAN_TO_APPLY_STARTED,
  });

  const applyConfig = {
    configurable: { thread_id: `${ctx.runId}-apply` },
    recursionLimit: 500,
  };

  // Phase 1: Re-invoke graph in APPLY mode with plan state injected.
  // checkpointResumed routes directly to human_approval (Story 10.1 router).
  startSpinner("Preparing to apply...");

  const phase1State = await ctx.graph.invoke(
    {
      userIntent: planState.userIntent,
      runId: ctx.runId,
      executionMode: ExecutionMode.APPLY,
      startedAt: Date.now(),
      projectDir: process.cwd(),
      resourceType: planState.resourceType,
      desiredState: planState.desiredState,
      estimatedMonthlyCost: planState.estimatedMonthlyCost,
      preflightPassed: planState.preflightPassed,
      elicitedOptions: planState.elicitedOptions,
      resourcePattern: planState.resourcePattern,
      resourceQueue: planState.resourceQueue,
      currentResourceIndex: planState.currentResourceIndex,
      completedResources: planState.completedResources,
      perResourceCosts: planState.perResourceCosts,
      bpFindings: planState.bpFindings,
      bpEnforcementLevel:
        userConfig?.bestPractices?.enforcement ?? BPEnforcementLevel.ENFORCE,
      checkpointResumed: true,
    },
    applyConfig,
  );

  stopSpinner();

  // User declined HITL confirmation
  if (phase1State.executionStatus === ExecutionStatus.CANCELLED) {
    log({
      ts: new Date().toISOString(),
      runId: ctx.runId,
      level: "info",
      action: LOG_ACTIONS.APPLY_COMPLETE,
      durationMs: Date.now() - ctx.startTs,
      result: ExecutionStatus.CANCELLED,
    });
    return { success: true };
  }

  if (
    phase1State.executionStatus === ExecutionStatus.FAILED ||
    phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
  ) {
    // Item 4b (2026-04-10): guide the user to the two most productive
    // next actions when Phase 1 fails. Plain "Apply failed" was both
    // blame-flavored and uninformative.
    renderError(
      phase1State.errorMessage ??
        "Apply could not start — the planning phase did not produce a valid plan.",
      "Run `assignee plan <intent>` first to see the full node trace. If the plan succeeds there, re-run `assignee apply` against the saved checkpoint in .assignee/. If the plan also fails, add `--verbose` to surface which node returned FAILED.",
    );
    return { success: false };
  }

  // Phase 2: Provisioning loop (shared with apply.ts)
  const { finalState: applyFinalState, success: applySuccess } =
    await runProvisioningLoop(ctx.graph, applyConfig, phase1State);

  log({
    ts: new Date().toISOString(),
    runId: ctx.runId,
    level: "info",
    action: LOG_ACTIONS.APPLY_COMPLETE,
    durationMs: Date.now() - ctx.startTs,
    result: applyFinalState.executionStatus,
  });

  return { success: applySuccess };
}
