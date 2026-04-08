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

/* Individual budget constants (ms) for direct import. */
export const CLI_PARSE_MS = 50;
export const CREDENTIAL_CHECK_MS = 200;
export const MCP_STARTUP_PER_SERVER_MS = 1000;
export const MCP_STARTUP_TOTAL_MS = 3000;
export const FIRST_LLM_CALL_MS = 5000;
export const TOTAL_COLD_START_MS = 10000;
/**
 * A4 (2026-04-08) — the "60s rule": every CLI command must either
 * complete within 60 seconds OR stream progress (spinners, log events)
 * so the user never faces a silent hang. The command-runner maps its
 * `total` timer to this budget via `timing.ts:LABEL_TO_BUDGET`; when
 * exceeded, a stderr WARNING fires at the end of the run pointing the
 * operator at either adding an `--async`/`--wait` flag or filing a
 * performance bug. Provisioning-heavy commands (apply, destroy) may
 * legitimately exceed 60s — the warning is informational, not a hard
 * failure, which matches the NFR rubric (soft QoS budget, not a gate).
 */
export const COMMAND_TOTAL_MS = 60000;

/** Per-phase startup time budgets. */
export const STARTUP_BUDGETS = {
  CLI_PARSE: { label: "CLI parse", budgetMs: CLI_PARSE_MS },
  CREDENTIAL_CHECK: {
    label: "Credential check",
    budgetMs: CREDENTIAL_CHECK_MS,
  },
  MCP_PER_SERVER: {
    label: "MCP startup (server)",
    budgetMs: MCP_STARTUP_PER_SERVER_MS,
  },
  MCP_TOTAL_PLAN: {
    label: "MCP startup (plan)",
    budgetMs: MCP_STARTUP_TOTAL_MS,
  },
  LLM_FIRST_CALL: { label: "First LLM call", budgetMs: FIRST_LLM_CALL_MS },
  TOTAL_COLD_START: {
    label: "Total cold start",
    budgetMs: TOTAL_COLD_START_MS,
  },
  // A4 (2026-04-08): the 60-second user-responsiveness budget.
  COMMAND_TOTAL: { label: "Total command runtime", budgetMs: COMMAND_TOTAL_MS },
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
