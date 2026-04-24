/**
 * CI guard test for startup time budget.
 * Validates that CLI cold start stays within the 10s budget.
 *
 * This test imports budget constants and validates the budget-check logic
 * rather than spawning a real child process (which requires full env setup).
 * The actual E2E timing test runs in the CI pipeline via the integration suite.
 *
 * @see Story 29.5 — Startup Time Budget with CI Guard
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  STARTUP_BUDGETS,
  checkTimingBudget,
  formatBudgetTable,
} from "../constants/time-budget.js";

describe("startup budget CI guard", () => {
  // Neutralise the 1.5× CI multiplier in checkTimingBudget so test
  // results are deterministic regardless of whether CI=true is set by
  // the runner. Every call in this file already passes an explicit
  // ciMultiplier, but stubbing CI removes the latent env dependency.
  // Pattern enforced by lint:ci-multiplier (T-006).
  beforeEach(() => {
    vi.stubEnv("CI", "");
  });
  it("total cold start budget is 10 seconds", () => {
    expect(STARTUP_BUDGETS.TOTAL_COLD_START.budgetMs).toBe(10_000);
  });

  it("budget check produces clear failure message when exceeded", () => {
    // Epic 98 e98.W5.P2 (B-16) raised MCP_TOTAL_PLAN budget 3000→5000ms.
    // Synthesise an over-budget reading at 6200ms (was 4200ms pre-W5.P2)
    // so the test still exercises the FAIL path — the message format
    // assertion is what this case guards against, not the specific
    // threshold number.
    const result = checkTimingBudget(
      STARTUP_BUDGETS.MCP_TOTAL_PLAN.label,
      6200,
      STARTUP_BUDGETS.MCP_TOTAL_PLAN.budgetMs,
      1.0,
    );

    expect(result.passed).toBe(false);
    expect(result.message).toBe(
      "BUDGET EXCEEDED: MCP startup (plan) took 6200ms (budget: 5000ms)",
    );
  });

  it("budget check passes for reasonable timings", () => {
    const timings = [
      { phase: STARTUP_BUDGETS.CLI_PARSE, actual: 20 },
      { phase: STARTUP_BUDGETS.CREDENTIAL_CHECK, actual: 100 },
      { phase: STARTUP_BUDGETS.MCP_PER_SERVER, actual: 500 },
      { phase: STARTUP_BUDGETS.MCP_TOTAL_PLAN, actual: 1500 },
      { phase: STARTUP_BUDGETS.LLM_FIRST_CALL, actual: 3000 },
      { phase: STARTUP_BUDGETS.TOTAL_COLD_START, actual: 5000 },
    ];

    for (const { phase, actual } of timings) {
      const result = checkTimingBudget(
        phase.label,
        actual,
        phase.budgetMs,
        1.0,
      );
      expect(result.passed).toBe(true);
    }
  });

  it("budget table shows pass/fail indicators for each phase", () => {
    const results = [
      checkTimingBudget("CLI parse", 30, 50, 1.0),
      checkTimingBudget("Credential check", 150, 200, 1.0),
      checkTimingBudget("MCP startup (plan)", 4200, 3000, 1.0),
      checkTimingBudget("Total cold start", 7000, 10000, 1.0),
    ];

    const table = formatBudgetTable(results);

    expect(table).toContain("PASS");
    expect(table).toContain("FAIL");
    expect(table).toContain("Phase");
    expect(table).toContain("Budget");
  });

  it("CI multiplier allows 1.5x headroom for slow runners", () => {
    // 70ms exceeds 50ms but is within 1.5x = 75ms
    const result = checkTimingBudget("CLI parse", 70, 50, 1.5);
    expect(result.passed).toBe(true);
  });
});
