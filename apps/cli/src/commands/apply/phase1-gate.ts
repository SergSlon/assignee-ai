/**
 * Post–Phase 1 outcome handler + budget guard.
 *
 * Classifies the Phase 1 terminal state, renders user-facing errors, and
 * implements the Story 43.2 "fix-and-continue" re-invocation path.
 */

import {
  ExecutionMode,
  ExecutionStatus,
  BPEnforcementLevel,
} from "@assignee/core";
import type { AgentState } from "../../services/graph.js";
import { renderError } from "../../utils/display.js";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { SUPPORTED_TYPES_HINT } from "../../config/constants.js";
import { checkBudget } from "../../services/budget-guard.js";
import type { Phase1Context, Phase1Deps } from "./phase1-planner.js";

/**
 * Result of evaluating the post-Phase-1 state:
 *  - `done`: return this result to the caller (exit early)
 *  - `continue`: proceed to Phase 2 with `phase1State`
 */
export type Phase1GateResult =
  | { kind: "done"; result: { success: boolean } }
  | { kind: "continue"; phase1State: AgentState };

/**
 * Re-invoke the graph from a clean state after interactive fixes resolved
 * all blocking BP findings (Story 43.2). Returns the new state.
 */
async function runFixAndContinue(
  ctx: Phase1Context,
  deps: Phase1Deps,
  phase1State: AgentState,
  residualFindings: AgentState["bpFindings"],
  effectiveIntent: string,
): Promise<AgentState> {
  log({
    ts: new Date().toISOString(),
    runId: ctx.runId,
    level: "info",
    action: LOG_ACTIONS.APPLY_COMPLETE,
    durationMs: Date.now() - ctx.startTs,
    result: "bp_fixed_continuing",
    extras: {
      fixCount: phase1State.appliedFixes!.length,
      residualFindings: (residualFindings ?? []).length,
    },
  });

  return ctx.graph.invoke(
    {
      checkpointResumed: true,
      userIntent: effectiveIntent,
      runId: ctx.runId,
      executionMode: ExecutionMode.APPLY,
      startedAt: Date.now(),
      projectDir: process.cwd(),
      resourceType: phase1State.resourceType,
      desiredState: phase1State.desiredState,
      estimatedMonthlyCost: phase1State.estimatedMonthlyCost,
      preflightPassed: true,
      bpFindings: residualFindings,
      appliedFixes: phase1State.appliedFixes,
      elicitedOptions: phase1State.elicitedOptions,
      resourceQueue: phase1State.resourceQueue,
      resourcePattern: phase1State.resourcePattern,
      bpEnforcementLevel:
        deps.userConfig?.bestPractices?.enforcement ??
        BPEnforcementLevel.ENFORCE,
      ...(deps.opts.yes ? { autoApprove: true } : {}),
      ...(deps.userConfig ? { userConfig: deps.userConfig } : {}),
      ...(deps.orgConfig ? { orgConfig: deps.orgConfig } : {}),
      ...(deps.resolvedSourceDir
        ? {
            sourceDir: deps.resolvedSourceDir,
            sourceFileCount: deps.sourceFileCount,
          }
        : {}),
    } as Parameters<typeof ctx.graph.invoke>[0],
    deps.graphConfig as Parameters<typeof ctx.graph.invoke>[1],
  );
}

/**
 * Evaluate Phase 1 state — early exit for cancelled/failed/blocked, or
 * re-invoke graph on successful interactive fix-and-continue, or signal
 * the caller to proceed to Phase 2.
 */
export async function handlePhase1Outcome(
  ctx: Phase1Context,
  deps: Phase1Deps,
  initialState: AgentState,
  effectiveIntent: string,
): Promise<Phase1GateResult> {
  let phase1State = initialState;

  // User declined or Ctrl+C in human_approval
  if (phase1State.executionStatus === ExecutionStatus.CANCELLED) {
    log({
      ts: new Date().toISOString(),
      runId: ctx.runId,
      level: "info",
      action: LOG_ACTIONS.APPLY_COMPLETE,
      durationMs: Date.now() - ctx.startTs,
      result: ExecutionStatus.CANCELLED,
    });
    return { kind: "done", result: { success: true } };
  }

  // Early failure (intent parse, schema fetch, plan gen, preflight, policy)
  if (
    phase1State.executionStatus === ExecutionStatus.FAILED ||
    phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE ||
    phase1State.executionStatus === ExecutionStatus.POLICY_BLOCKED
  ) {
    log({
      ts: new Date().toISOString(),
      runId: ctx.runId,
      level: "info",
      action: LOG_ACTIONS.APPLY_COMPLETE,
      durationMs: Date.now() - ctx.startTs,
      result: phase1State.executionStatus,
    });
    const defaultHint =
      phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
        ? SUPPORTED_TYPES_HINT
        : "Try rephrasing your intent, or run `assignee --verbose apply <intent>` to see which node returned FAILED. Common causes: Bedrock region mismatch, missing credentials, or an intent the LLM could not map to a supported type.";
    renderError(
      phase1State.errorMessage ??
        "Apply could not start — the planning phase did not produce a valid plan.",
      defaultHint,
    );
    return { kind: "done", result: { success: false } };
  }

  // BP findings blocked the apply — plan box already rendered by result_formatter
  if (
    phase1State.executionStatus === ExecutionStatus.PENDING &&
    phase1State.preflightPassed === false
  ) {
    // Story 43.2: Fix-and-continue
    const residualFindings = phase1State.bpFindings ?? [];
    const hasBlockingRemaining = residualFindings.some((f) => f.blocking);
    const fixesApplied =
      phase1State.appliedFixes && phase1State.appliedFixes.length > 0;

    if (fixesApplied && !hasBlockingRemaining) {
      phase1State = await runFixAndContinue(
        ctx,
        deps,
        phase1State,
        residualFindings,
        effectiveIntent,
      );
      // Handle rejection during re-invocation
      if (phase1State.executionStatus === ExecutionStatus.CANCELLED) {
        log({
          ts: new Date().toISOString(),
          runId: ctx.runId,
          level: "info",
          action: LOG_ACTIONS.APPLY_COMPLETE,
          durationMs: Date.now() - ctx.startTs,
          result: ExecutionStatus.CANCELLED,
        });
        return { kind: "done", result: { success: true } };
      }
      // Fall through to budget check + Phase 2 below
    } else {
      log({
        ts: new Date().toISOString(),
        runId: ctx.runId,
        level: "info",
        action: LOG_ACTIONS.APPLY_COMPLETE,
        durationMs: Date.now() - ctx.startTs,
        result: "bp_blocked",
      });
      return { kind: "done", result: { success: false } };
    }
  }

  // Catch-all: unexpected status after phase 1
  if (
    phase1State.executionStatus !== ExecutionStatus.IN_PROGRESS &&
    phase1State.executionStatus !== ExecutionStatus.PENDING
  ) {
    log({
      ts: new Date().toISOString(),
      runId: ctx.runId,
      level: "error",
      action: LOG_ACTIONS.APPLY_COMPLETE,
      durationMs: Date.now() - ctx.startTs,
      result: phase1State.executionStatus,
      extras: { errorMessage: phase1State.errorMessage },
    });
    renderError(
      phase1State.errorMessage ??
        `Apply stopped after planning in an unexpected state (${phase1State.executionStatus}).`,
      "This usually means a downstream node returned a status the apply loop doesn't know how to handle. Run `assignee --verbose apply <intent>` to capture the full node trace, then open an issue with the trace attached.",
    );
    return { kind: "done", result: { success: false } };
  }

  // ── Budget panic limit check (FR-09) ─────────────────────────────
  const budgetCheck = checkBudget(
    phase1State.estimatedMonthlyCost as string | undefined,
    deps.userConfig?.["budget"] as
      | import("@assignee/core").ConfigBudget
      | undefined,
  );
  if (budgetCheck.status === "blocked") {
    renderError(budgetCheck.message);
    return { kind: "done", result: { success: false } };
  }
  if (
    budgetCheck.status === "warning" ||
    budgetCheck.status === "unparseable"
  ) {
    process.stderr.write(`\u001B[33m${budgetCheck.message}\u001B[0m\n`);
  }

  return { kind: "continue", phase1State };
}
