/**
 * Startup time budgets for Assignee CLI phases.
 * Used by CI guards and the `assignee debug budget` command.
 *
 * @see Story 29.5 — Startup Time Budget with CI Guard
 */

export interface BudgetEntry {
  /** Human-readable label for the phase */
  label: string;
  /** Maximum allowed time in milliseconds */
  budgetMs: number;
}

export interface BudgetCheckResult {
  /** Whether the phase is within budget */
  passed: boolean;
  /** Phase label */
  label: string;
  /** Actual duration in milliseconds */
  actualMs: number;
  /** Budget threshold in milliseconds */
  budgetMs: number;
  /** Human-readable result message */
  message: string;
}

/** Per-phase startup time budgets. */
export const STARTUP_BUDGETS = {
  CLI_PARSE: { label: "CLI parse", budgetMs: 50 },
  CREDENTIAL_CHECK: { label: "Credential check", budgetMs: 200 },
  MCP_PER_SERVER: { label: "MCP startup (server)", budgetMs: 1000 },
  MCP_TOTAL_PLAN: { label: "MCP startup (plan)", budgetMs: 3000 },
  LLM_FIRST_CALL: { label: "First LLM call", budgetMs: 5000 },
  TOTAL_COLD_START: { label: "Total cold start", budgetMs: 10000 },
} as const;

/** All budgets as an iterable array. */
export const ALL_BUDGETS: BudgetEntry[] = Object.values(STARTUP_BUDGETS);

/**
 * Check if an actual duration is within its budget.
 *
 * @param label - Phase label (for reporting)
 * @param actualMs - Actual measured duration in ms
 * @param budgetMs - Budget threshold in ms
 * @param ciMultiplier - Multiplier for CI runners (default 1.5 when CI=true)
 * @returns BudgetCheckResult with pass/fail and human-readable message
 */
export function checkBudget(
  label: string,
  actualMs: number,
  budgetMs: number,
  ciMultiplier?: number,
): BudgetCheckResult {
  const multiplier = ciMultiplier ?? (process.env["CI"] ? 1.5 : 1.0);
  const effectiveBudget = budgetMs * multiplier;
  const passed = actualMs <= effectiveBudget;

  const message = passed
    ? `PASS: ${label} took ${actualMs.toFixed(0)}ms (budget: ${budgetMs}ms)`
    : `BUDGET EXCEEDED: ${label} took ${actualMs.toFixed(0)}ms (budget: ${budgetMs}ms)`;

  return { passed, label, actualMs, budgetMs, message };
}

/**
 * Format a budget check result table for terminal output.
 */
export function formatBudgetTable(results: BudgetCheckResult[]): string {
  const lines: string[] = [];
  const header = `${"Phase".padEnd(25)} ${"Actual".padEnd(10)} ${"Budget".padEnd(10)} Status`;
  lines.push(header);
  lines.push("─".repeat(header.length));

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const line = `${r.label.padEnd(25)} ${(r.actualMs.toFixed(0) + "ms").padEnd(10)} ${(r.budgetMs + "ms").padEnd(10)} ${status}`;
    lines.push(line);
  }

  return lines.join("\n");
}
