/**
 * Post–Phase 1 outcome handler + budget guard.
 *
 * Classifies the Phase 1 terminal state, renders user-facing errors, and
 * implements the Story 43.2 "fix-and-continue" re-invocation path.
 *
 * The main `handlePhase1Outcome` is a thin dispatcher; each terminal
 * status has its own focused branch handler so that clarifier-retry,
 * fix-and-continue, catch-all, and budget-check logic can each be read
 * and tested in isolation.
 */

import {
  ExecutionMode,
  ExecutionStatus,
  BPEnforcementLevel,
  type ConfigBudget,
  type ExecutionStatusType,
} from "@assignee/core";
import type { AgentState } from "../../services/graph.js";
import { renderError } from "../../utils/display.js";
import { log, LOG_ACTIONS, type LogLevelType } from "../../utils/logger.js";
import { SUPPORTED_TYPES_HINT } from "../../config/constants.js";
import { checkBudget } from "../../services/budget-guard.js";
import { askClarifyingQuestion } from "../../services/clarifier.js";
import {
  buildFreshPlanState,
  type Phase1Context,
  type Phase1Deps,
} from "./phase1-planner.js";

/**
 * Result of evaluating the post-Phase-1 state:
 *  - `done`: return this result to the caller (exit early)
 *  - `continue`: proceed to Phase 2 with `phase1State`
 */
export type Phase1GateResult =
  | { kind: "done"; result: { success: boolean } }
  | { kind: "continue"; phase1State: AgentState };

const FAILURE_STATUSES: readonly ExecutionStatusType[] = [
  ExecutionStatus.FAILED,
  ExecutionStatus.UNSUPPORTED_RESOURCE,
  ExecutionStatus.POLICY_BLOCKED,
];

function isFailureStatus(status: ExecutionStatusType | undefined): boolean {
  return status !== undefined && FAILURE_STATUSES.includes(status);
}

/**
 * Emit the standard `apply_complete` log record. Centralises the 6
 * duplicated log-call shapes across the gate branches.
 */
function logApplyComplete(
  ctx: Phase1Context,
  result: string,
  extras?: Record<string, unknown>,
  level: LogLevelType = "info",
): void {
  log({
    ts: new Date().toISOString(),
    runId: ctx.runId,
    level,
    action: LOG_ACTIONS.APPLY_COMPLETE,
    durationMs: Date.now() - ctx.startTs,
    result,
    ...(extras ? { extras } : {}),
  });
}

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
  logApplyComplete(ctx, "bp_fixed_continuing", {
    fixCount: phase1State.appliedFixes!.length,
    residualFindings: (residualFindings ?? []).length,
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
 * Story 52-1: offer ONE clarifying rephrase when Phase 1 failed on
 * intent-ambiguity. Bypassed silently for `--yes` / `--quick` / non-TTY
 * and for POLICY_BLOCKED (policy is not an intent problem). Returns the
 * state AFTER an optional re-invoke; identical to input if no retry.
 */
async function maybeRetryWithClarifier(
  ctx: Phase1Context,
  deps: Phase1Deps,
  phase1State: AgentState,
): Promise<AgentState> {
  if (phase1State.executionStatus === ExecutionStatus.POLICY_BLOCKED) {
    return phase1State;
  }
  const rephrased = await askClarifyingQuestion({
    state: phase1State,
    autoApprove: deps.opts.yes === true,
    quick: deps.opts.quick === true,
  });
  if (!rephrased) return phase1State;

  ctx.intent = rephrased;
  return (await ctx.graph.invoke(
    buildFreshPlanState(ctx, deps) as Parameters<typeof ctx.graph.invoke>[0],
    deps.graphConfig as Parameters<typeof ctx.graph.invoke>[1],
  )) as AgentState;
}

/** Render the user-facing error for a terminal Phase-1 failure. */
function renderFailureError(phase1State: AgentState): void {
  const defaultHint =
    phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
      ? SUPPORTED_TYPES_HINT
      : "Try rephrasing your intent, or run `assignee --verbose apply <intent>` to see which node returned FAILED. Common causes: Bedrock region mismatch, missing credentials, or an intent the LLM could not map to a supported type.";
  renderError(
    phase1State.errorMessage ??
      "Apply could not start — the planning phase did not produce a valid plan.",
    defaultHint,
  );
}

/**
 * Handle FAILED / UNSUPPORTED_RESOURCE / POLICY_BLOCKED. Runs the
 * clarifier retry (if eligible); re-checks; either exits with a rendered
 * error or returns `null` for the caller to fall through on a clarifier
 * success.
 */
async function handleFailureClass(
  ctx: Phase1Context,
  deps: Phase1Deps,
  phase1State: AgentState,
): Promise<{ next: AgentState; result: Phase1GateResult | null }> {
  const afterRetry = await maybeRetryWithClarifier(ctx, deps, phase1State);
  if (!isFailureStatus(afterRetry.executionStatus)) {
    return { next: afterRetry, result: null };
  }
  logApplyComplete(ctx, afterRetry.executionStatus as string);
  renderFailureError(afterRetry);
  return {
    next: afterRetry,
    result: { kind: "done", result: { success: false } },
  };
}

/**
 * Handle `PENDING` + `preflightPassed === false` — the BP-findings gate.
 * Either runs Story 43.2 fix-and-continue (may cancel) or reports
 * bp_blocked. Returns `null` + an updated state when the caller should
 * fall through to the budget check.
 */
async function handleBpBlocked(
  ctx: Phase1Context,
  deps: Phase1Deps,
  phase1State: AgentState,
  effectiveIntent: string,
): Promise<{ next: AgentState; result: Phase1GateResult | null }> {
  const residualFindings = phase1State.bpFindings ?? [];
  const hasBlockingRemaining = residualFindings.some((f) => f.blocking);
  const fixesApplied =
    phase1State.appliedFixes && phase1State.appliedFixes.length > 0;

  if (!fixesApplied || hasBlockingRemaining) {
    logApplyComplete(ctx, "bp_blocked");
    return {
      next: phase1State,
      result: { kind: "done", result: { success: false } },
    };
  }

  const next = await runFixAndContinue(
    ctx,
    deps,
    phase1State,
    residualFindings,
    effectiveIntent,
  );
  if (next.executionStatus === ExecutionStatus.CANCELLED) {
    logApplyComplete(ctx, ExecutionStatus.CANCELLED);
    return { next, result: { kind: "done", result: { success: true } } };
  }
  return { next, result: null };
}

/** Render + log the catch-all "unexpected status after Phase 1" path. */
function handleUnexpectedStatus(
  ctx: Phase1Context,
  phase1State: AgentState,
): Phase1GateResult {
  logApplyComplete(
    ctx,
    phase1State.executionStatus as string,
    { errorMessage: phase1State.errorMessage },
    "error",
  );
  renderError(
    phase1State.errorMessage ??
      `Apply stopped after planning in an unexpected state (${phase1State.executionStatus}).`,
    "This usually means a downstream node returned a status the apply loop doesn't know how to handle. Run `assignee --verbose apply <intent>` to capture the full node trace, then open an issue with the trace attached.",
  );
  return { kind: "done", result: { success: false } };
}

/** Budget panic-limit check (FR-09). Writes warnings to stderr. */
function runBudgetGuard(
  phase1State: AgentState,
  deps: Phase1Deps,
): Phase1GateResult | null {
  const budgetCheck = checkBudget(
    phase1State.estimatedMonthlyCost as string | undefined,
    deps.userConfig?.["budget"] as ConfigBudget | undefined,
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
  return null;
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

  if (phase1State.executionStatus === ExecutionStatus.CANCELLED) {
    logApplyComplete(ctx, ExecutionStatus.CANCELLED);
    return { kind: "done", result: { success: true } };
  }

  if (isFailureStatus(phase1State.executionStatus)) {
    const { next, result } = await handleFailureClass(ctx, deps, phase1State);
    if (result) return result;
    phase1State = next;
  }

  if (
    phase1State.executionStatus === ExecutionStatus.PENDING &&
    phase1State.preflightPassed === false
  ) {
    const { next, result } = await handleBpBlocked(
      ctx,
      deps,
      phase1State,
      effectiveIntent,
    );
    if (result) return result;
    phase1State = next;
  }

  if (
    phase1State.executionStatus !== ExecutionStatus.IN_PROGRESS &&
    phase1State.executionStatus !== ExecutionStatus.PENDING
  ) {
    return handleUnexpectedStatus(ctx, phase1State);
  }

  const budgetResult = runBudgetGuard(phase1State, deps);
  if (budgetResult) return budgetResult;

  return { kind: "continue", phase1State };
}
