/**
 * human_approval node — shows plan box and requests HITL confirmation.
 * Runs in Phase 1 of apply, before the LangGraph interrupt at resource_provisioner.
 * If user declines or cancels, sets executionStatus: CANCELLED.
 *
 * Story 11.2: --yes flag auto-confirms without interactive prompt (for CI/CD).
 * Preflight is never bypassed — it runs before this node in the graph.
 *
 * Story 50-4 Wave 5 finale: lifted to `@assignee/core/graph/nodes/` so
 * `createGraph` can live in core. Preserves
 * `feedback_approve_plan_once_then_execute` — interrupt semantics intact.
 *
 * @see Story 2-1, Story 8-3, Story 11-2
 */

import { ExecutionStatus } from "../../index.js";
import {
  renderPlanBox,
  renderHitlConfirm,
  renderDependencyPlan,
  renderHitlCompoundConfirm,
  promptFixSelection,
} from "../../utils/display.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import type { AgentState } from "../graph-state.js";

export async function humanApprovalNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  // Story 11.2: --yes flag auto-approves without interactive prompt
  if (state.autoApprove) {
    // Warn if used in an interactive TTY session
    if (process.stdout.isTTY) {
      process.stderr.write(
        "Warning: --yes flag used in interactive session. Auto-approving without confirmation.\n",
      );
    }

    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.APPLY_AUTO_APPROVED,
      extras: {
        autoApproved: true,
        flag: "--yes",
        approvalSource: "autoApprove",
        isTTY: process.stdin.isTTY,
      },
    });

    return {};
  }

  // Story 11.2: non-TTY without --yes is an error
  if (!process.stdin.isTTY) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "Apply requires confirmation. Use --yes for non-interactive mode.",
    };
  }

  // Plan-to-apply flow: user already confirmed in plan.ts, skip second prompt
  if (state.checkpointResumed) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_APPROVED,
      extras: {
        checkpointResumed: true,
        source: "plan-to-apply",
        approvalSource: "checkpointResume",
      },
    });
    return {};
  }

  let confirmed: boolean;
  let fixResult: Awaited<ReturnType<typeof promptFixSelection>> = null;

  if (state.resourcePattern && state.resourceQueue) {
    // Compound intent: show dependency plan (Story 8.3)
    renderDependencyPlan(
      state.resourcePattern,
      state.resourceQueue,
      state.perResourceCosts,
      state.bpFindings,
    );

    // Interactive fix selection for compound patterns too (same as single resource)
    fixResult = await promptFixSelection(state);
    if (fixResult) {
      // Re-render dependency plan with updated findings
      renderDependencyPlan(
        state.resourcePattern,
        state.resourceQueue,
        state.perResourceCosts,
        fixResult.bpFindings,
      );
    }

    confirmed = await renderHitlCompoundConfirm(
      state.resourcePattern,
      state.resourceQueue.length,
    );
  } else {
    renderPlanBox(state);

    // Story 35.4: Interactive fix selection after plan display (TTY only)
    let effectiveState = state;
    fixResult = await promptFixSelection(state);
    if (fixResult) {
      effectiveState = {
        ...state,
        desiredState: fixResult.desiredState,
        bpFindings: fixResult.bpFindings,
        appliedFixes: fixResult.appliedFixes,
        // Clear stale cost — fixes may change config that affects pricing
        estimatedMonthlyCost: undefined,
        pricingBreakdown: undefined,
      } as AgentState;
      renderPlanBox(effectiveState);
    }

    confirmed = await renderHitlConfirm(effectiveState);
  }

  if (!confirmed) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_REJECTED,
    });
    return { executionStatus: ExecutionStatus.CANCELLED };
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PLAN_APPROVED,
    extras: { approvalSource: "interactive" },
  });

  // Story 35.4: Return updated state if fixes were applied
  if (fixResult) {
    return {
      desiredState: fixResult.desiredState,
      bpFindings: fixResult.bpFindings,
      appliedFixes: fixResult.appliedFixes,
      // Clear stale cost in graph state too (not just display)
      estimatedMonthlyCost: undefined,
      pricingBreakdown: undefined,
    };
  }

  return {};
}
