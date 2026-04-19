/**
 * BP-findings gate handler: `PENDING` + `preflightPassed === false`.
 * Either runs Story 43.2 fix-and-continue (which may cancel) or reports
 * bp_blocked. Returns `null` + an updated state when the caller should
 * fall through to the budget check.
 */

import { ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../../../services/graph.js";
import type { Phase1Context, Phase1Deps } from "../phase1-planner.js";
import { buildContinueInvocation } from "./invocation-builder.js";
import { logApplyComplete } from "./log-helpers.js";
import type { Phase1GateResult } from "./types.js";

/**
 * Re-invoke the graph from a clean state after interactive fixes resolved
 * all blocking BP findings (Story 43.2). Returns the new state. The
 * invocation-argument shape is built by `buildContinueInvocation` so the
 * 6 conditional spreads are unit-tested in isolation.
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
    buildContinueInvocation(
      ctx,
      deps,
      phase1State,
      residualFindings,
      effectiveIntent,
    ) as Parameters<typeof ctx.graph.invoke>[0],
    deps.graphConfig as Parameters<typeof ctx.graph.invoke>[1],
  );
}

export async function handleBpBlocked(
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
