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
/**
 * MCP startup budget — total across all required servers on the cold-
 * path for `plan` / `apply`. Raised from 3000ms → 5000ms in Epic 98
 * e98.W5.P2 (Epic 97 B-16): the 3000ms threshold fired on nearly every
 * cold plan run (observed 3108-9967ms on dogfood probes), so the
 * WARNING was noise rather than signal. 5000ms keeps the gate tight
 * enough to catch genuine regressions (e.g. a 10x MCP spawn cost)
 * while staying above the realistic cold-start floor.
 */
export const MCP_STARTUP_TOTAL_MS = 5000;
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

/**
 * Epic 98 e98.W5.P2 (Epic 97 A-03 + A-07): per-resource-type override
 * for the `total` command budget. Some CloudControl creation paths are
 * inherently slower than the 60s rule because AWS itself imposes a
 * longer eventual-consistency window; warning on them is noise.
 *
 * - SQS: AWS's queue-name-reuse rule holds a `QueueUrl` for 60s after
 *   delete and a fresh create races the release. Observed wall clock
 *   73-74s on every `assignee infra apply` of a standard queue (dogfood
 *   slice A). 90s gives ~20% headroom over worst-case observation.
 * - CloudFront Distribution: AWS edge-deployment finalisation
 *   intrinsically takes 3-5 min in the typical case (and can take
 *   up to 25 min per AWS docs). Observed 5m04s wall clock on the
 *   static-website compound (2026-05-11). 6 min override comfortably
 *   covers the typical case while still flagging the genuine outlier
 *   (>10 min) — a real signal worth a WARNING.
 *
 * Callers set the context via `timing.setApplyBudgetContext()` when
 * they know the terminal resourceType (post-Phase-1 in apply). For
 * compound apply, callers should pass the FULL list of completed
 * resource types so the max override across all of them is selected
 * (compound bottleneck != terminal resource — e.g. static-website
 * terminates on BucketPolicy but the CloudFront step is the gate).
 * When unset, `total` falls back to `COMMAND_TOTAL_MS`.
 */
export const APPLY_TOTAL_OVERRIDES_MS: Readonly<Record<string, number>> = {
  "AWS::SQS::Queue": 90000,
  "AWS::CloudFront::Distribution": 360000,
};

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
export function checkTimingBudget(
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
