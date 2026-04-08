import { describe, it, expect } from "vitest";
import {
  CLI_PARSE_MS,
  CREDENTIAL_CHECK_MS,
  MCP_STARTUP_PER_SERVER_MS,
  MCP_STARTUP_TOTAL_MS,
  FIRST_LLM_CALL_MS,
  TOTAL_COLD_START_MS,
  STARTUP_BUDGETS,
  ALL_BUDGETS,
  checkBudget,
  formatBudgetTable,
} from "./time-budget.js";

describe("time-budget", () => {
  describe("individual budget constants", () => {
    it("exports CLI_PARSE_MS = 50", () => {
      expect(CLI_PARSE_MS).toBe(50);
    });

    it("exports CREDENTIAL_CHECK_MS = 200", () => {
      expect(CREDENTIAL_CHECK_MS).toBe(200);
    });

    it("exports MCP_STARTUP_PER_SERVER_MS = 1000", () => {
      expect(MCP_STARTUP_PER_SERVER_MS).toBe(1000);
    });

    it("exports MCP_STARTUP_TOTAL_MS = 3000", () => {
      expect(MCP_STARTUP_TOTAL_MS).toBe(3000);
    });

    it("exports FIRST_LLM_CALL_MS = 5000", () => {
      expect(FIRST_LLM_CALL_MS).toBe(5000);
    });

    it("exports TOTAL_COLD_START_MS = 10000", () => {
      expect(TOTAL_COLD_START_MS).toBe(10000);
    });
  });

  describe("STARTUP_BUDGETS constants", () => {
    it("defines CLI_PARSE budget at 50ms", () => {
      expect(STARTUP_BUDGETS.CLI_PARSE.budgetMs).toBe(50);
    });

    it("defines CREDENTIAL_CHECK budget at 200ms", () => {
      expect(STARTUP_BUDGETS.CREDENTIAL_CHECK.budgetMs).toBe(200);
    });

    it("defines MCP_PER_SERVER budget at 1000ms", () => {
      expect(STARTUP_BUDGETS.MCP_PER_SERVER.budgetMs).toBe(1000);
    });

    it("defines MCP_TOTAL_PLAN budget at 3000ms", () => {
      expect(STARTUP_BUDGETS.MCP_TOTAL_PLAN.budgetMs).toBe(3000);
    });

    it("defines LLM_FIRST_CALL budget at 5000ms", () => {
      expect(STARTUP_BUDGETS.LLM_FIRST_CALL.budgetMs).toBe(5000);
    });

    it("defines TOTAL_COLD_START budget at 10000ms", () => {
      expect(STARTUP_BUDGETS.TOTAL_COLD_START.budgetMs).toBe(10000);
    });
  });

  describe("ALL_BUDGETS", () => {
    it("contains all 6 budget entries", () => {
      expect(ALL_BUDGETS).toHaveLength(6);
    });

    it("each entry has non-empty label and positive budgetMs", () => {
      // Tier C: dropped redundant toBeDefined() — typeof checks are
      // strictly stronger
      for (const entry of ALL_BUDGETS) {
        expect(typeof entry.label).toBe("string");
        expect(entry.label.length).toBeGreaterThan(0);
        expect(typeof entry.budgetMs).toBe("number");
        expect(entry.budgetMs).toBeGreaterThan(0);
      }
    });
  });

  describe("checkBudget", () => {
    it("returns passed=true when actual is below budget", () => {
      const result = checkBudget("CLI parse", 30, 50, 1.0);
      expect(result.passed).toBe(true);
      expect(result.message).toContain("PASS");
    });

    it("returns passed=true when actual equals budget", () => {
      const result = checkBudget("CLI parse", 50, 50, 1.0);
      expect(result.passed).toBe(true);
    });

    it("returns passed=false when actual exceeds budget", () => {
      const result = checkBudget("MCP startup", 4200, 3000, 1.0);
      expect(result.passed).toBe(false);
      expect(result.message).toContain("BUDGET EXCEEDED");
      expect(result.message).toContain("4200ms");
      expect(result.message).toContain("3000ms");
    });

    it("applies CI multiplier to budget", () => {
      // Without multiplier: 120ms > 50ms budget → FAIL
      const failResult = checkBudget("CLI parse", 70, 50, 1.0);
      expect(failResult.passed).toBe(false);

      // With 1.5x CI multiplier: 70ms <= 75ms effective → PASS
      const passResult = checkBudget("CLI parse", 70, 50, 1.5);
      expect(passResult.passed).toBe(true);
    });

    it("preserves label and durations in result", () => {
      const result = checkBudget("Test phase", 42, 100, 1.0);
      expect(result.label).toBe("Test phase");
      expect(result.actualMs).toBe(42);
      expect(result.budgetMs).toBe(100);
    });
  });

  describe("formatBudgetTable", () => {
    it("formats results into a table with header", () => {
      const results = [
        checkBudget("CLI parse", 30, 50, 1.0),
        checkBudget("MCP startup", 4200, 3000, 1.0),
      ];

      const output = formatBudgetTable(results);
      expect(output).toContain("Phase");
      expect(output).toContain("Actual");
      expect(output).toContain("Budget");
      expect(output).toContain("Status");
      expect(output).toContain("PASS");
      expect(output).toContain("FAIL");
    });

    it("shows millisecond units", () => {
      const results = [checkBudget("Test", 42, 100, 1.0)];
      const output = formatBudgetTable(results);
      expect(output).toContain("42ms");
      expect(output).toContain("100ms");
    });
  });
});
