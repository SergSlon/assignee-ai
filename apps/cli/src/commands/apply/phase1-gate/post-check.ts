/**
 * Post-check helpers for the Phase 1 dispatcher: the catch-all
 * "unexpected status" path and the budget panic-limit guard (FR-09).
 */

import { type ConfigBudget } from "@assignee/core";
import type { AgentState } from "../../../services/graph.js";
import { renderError } from "../../../utils/display.js";
import { checkMonthlyCostBudget } from "../../../services/budget-guard.js";
import type { Phase1Context, Phase1Deps } from "../phase1-planner.js";
import { logApplyComplete } from "./log-helpers.js";
import type { Phase1GateResult } from "./types.js";

/** Render + log the catch-all "unexpected status after Phase 1" path. */
export function handleUnexpectedStatus(
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
export function runBudgetGuard(
  phase1State: AgentState,
  deps: Phase1Deps,
): Phase1GateResult | null {
  const budgetCheck = checkMonthlyCostBudget(
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
