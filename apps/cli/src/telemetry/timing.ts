/**
 * Lightweight timing instrumentation for measuring CLI phase durations.
 *
 * All data is local-only (zero network calls). Persistence can be disabled
 * by setting `ASSIGNEE_NO_TELEMETRY=1`.
 *
 * @see Story 29.1
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  STARTUP_BUDGETS,
  APPLY_TOTAL_OVERRIDES_MS,
  checkTimingBudget,
} from "../constants/time-budget.js";
import { EnvVar } from "../constants/env-vars.js";
import { ASSIGNEE_DIR } from "../config/constants.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface TimingPhase {
  label: string;
  durationMs: number;
}

export interface TimingRun {
  version: 1;
  runId: string;
  timestamp: string;
  phases: TimingPhase[];
}

/* ------------------------------------------------------------------ */
/*  TimingStore                                                        */
/* ------------------------------------------------------------------ */

const pending = new Map<string, bigint>();
const completed = new Map<string, number>();

/**
 * Start a named timer. Uses `process.hrtime.bigint()` for sub-ms precision.
 */
export function startTimer(label: string): void {
  pending.set(label, process.hrtime.bigint());
}

/**
 * End a named timer and return elapsed milliseconds.
 * Throws if the timer was never started.
 */
export function endTimer(label: string): number {
  const start = pending.get(label);
  if (start === undefined) {
    throw new Error(`Timer "${label}" was never started`);
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
  pending.delete(label);
  completed.set(label, elapsed);
  return elapsed;
}

/**
 * Returns all completed timings as a plain object.
 */
export function getTimings(): Record<string, number> {
  return Object.fromEntries(completed);
}

/**
 * Human-readable table of all completed timings.
 */
export function formatTimings(): string {
  if (completed.size === 0) return "No timings recorded.";

  const lines: string[] = [];
  for (const [label, ms] of completed) {
    lines.push(`  ${label.padEnd(30)} ${ms.toFixed(1)}ms`);
  }
  return lines.join("\n");
}

/**
 * Format a one-line summary suitable for displaying after a run.
 *
 * Example: "First run complete in 5.4s (credential check: 0.05s, MCP startup: 1.2s, LLM: 2.1s)"
 */
export function formatSummary(): string {
  const total = completed.get("total");
  const parts: string[] = [];

  for (const [label, ms] of completed) {
    if (label === "total") continue;
    parts.push(`${label}: ${(ms / 1000).toFixed(2)}s`);
  }

  const totalStr = total !== undefined ? `${(total / 1000).toFixed(1)}s` : "?s";
  if (parts.length === 0) return `Run complete in ${totalStr}`;
  return `Run complete in ${totalStr} (${parts.join(", ")})`;
}

/**
 * Wraps an async function with start/end timing.
 */
export async function withTiming<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  startTimer(label);
  try {
    return await fn();
  } finally {
    endTimer(label);
  }
}

/* ------------------------------------------------------------------ */
/*  Budget comparison                                                   */
/* ------------------------------------------------------------------ */

/** Map of timing labels to their corresponding budget entry. */
const LABEL_TO_BUDGET: Record<string, { label: string; budgetMs: number }> = {
  "cli-parse": STARTUP_BUDGETS.CLI_PARSE,
  "credential-check": STARTUP_BUDGETS.CREDENTIAL_CHECK,
  "mcp-startup": STARTUP_BUDGETS.MCP_TOTAL_PLAN,
  "first-llm-call": STARTUP_BUDGETS.LLM_FIRST_CALL,
  // A4 (2026-04-08) — the "total" timer covers the entire command
  // runtime (from runCommand entry through the outer finally), not
  // cold start. Its budget target was previously TOTAL_COLD_START
  // (10s) which fired WARNING for almost every real plan/apply run.
  // Moved to COMMAND_TOTAL (60s — the 60s rule) so cold-start
  // budgets remain enforced via the individual sub-phases above
  // (cli-parse + credential-check + mcp-startup + first-llm-call),
  // and the "total" warning only surfaces when a command is
  // genuinely blocking the user for too long.
  total: STARTUP_BUDGETS.COMMAND_TOTAL,
};

/**
 * Epic 98 e98.W5.P2 (Epic 97 A-03 + A-07): per-apply resource-type
 * context used to swap the `total` budget for resource types with
 * inherently longer CCAPI completion windows (SQS, CloudFront — see
 * `APPLY_TOTAL_OVERRIDES_MS`).
 *
 * For single-resource apply this carries one type; for compound apply
 * it carries every successfully-completed resource type so the max
 * override across all of them wins. Static-website is the motivating
 * compound: it terminates on BucketPolicy (no override) but the
 * CloudFront Distribution step gates the whole run for 3-5 min — only
 * the compound-aware lookup catches that.
 *
 * Set by the apply orchestrator after Phase 1 resolves the resource
 * list; read by `checkTimingsAgainstBudgets` on persist. Undefined on
 * non-apply commands / pre-Phase-1 exits → default COMMAND_TOTAL_MS
 * stays in force. Cleared by `resetTimings()` so tests don't leak.
 */
let applyResourceTypes: readonly string[] | undefined;

/**
 * Set the resource-type context for the `total`-budget override. Call
 * this once per apply run, after the graph resolves the resource list
 * and before `persistTimings` fires. Accepts a single type (single
 * apply) or an array (compound apply — full `completedResources`
 * types).
 */
export function setApplyBudgetContext(
  resourceTypes: string | readonly string[] | undefined,
): void {
  if (resourceTypes === undefined) {
    applyResourceTypes = undefined;
    return;
  }
  applyResourceTypes =
    typeof resourceTypes === "string" ? [resourceTypes] : resourceTypes;
}

/**
 * Return the effective `total` budget for the current run, consulting
 * the per-resource-type override map when an apply context has been
 * set. For compound apply, the MAX override across all completed
 * resource types wins — the slowest resource gates the budget.
 * Pure-function surface so the check is easy to unit-test.
 */
function effectiveTotalBudgetMs(): number {
  const defaultBudget: number = STARTUP_BUDGETS.COMMAND_TOTAL.budgetMs;
  if (applyResourceTypes === undefined || applyResourceTypes.length === 0) {
    return defaultBudget;
  }
  let max: number = defaultBudget;
  for (const resourceType of applyResourceTypes) {
    const override = APPLY_TOTAL_OVERRIDES_MS[resourceType];
    if (override !== undefined && override > max) {
      max = override;
    }
  }
  return max;
}

/**
 * DF-PLAN-BUDGET-WARNING-AFTER-SUCCESS (live verify 2026-05-12): the
 * `total` timer fires its BUDGET EXCEEDED warning after a successful
 * `assignee infra plan` that genuinely took 81s due to slow MCP cold-start
 * + LLM latency. The original "60s rule" intent was to catch silent
 * hangs — when the command succeeded, the user already got their
 * answer; the warning is pure noise (and contradicts the ✓ Operation
 * completed successfully line directly above it).
 *
 * Setter is called from the runner's finally block once the
 * command-level outcome is known, BEFORE persistTimings →
 * checkTimingsAgainstBudgets fires. Only the `total` warning is
 * suppressed on success; the per-phase warnings (cli-parse,
 * mcp-startup, first-llm-call) keep firing because they measure
 * cold-start independent of command outcome.
 *
 * Apply context overrides (PR #51) stack with this: a CloudFront
 * compound apply that takes 5min AND succeeds skips the warning via
 * BOTH paths.
 */
let commandSucceeded: boolean | undefined;

/**
 * Set the command-level success flag for the budget check. Pass
 * `true` from the runner's success path, `false` from the failure
 * path. When set to `true`, `checkTimingsAgainstBudgets` suppresses
 * the `total` warning regardless of overrun (other phase warnings
 * still fire). When unset or `false`, the previous behavior holds.
 */
export function setCommandResult(succeeded: boolean | undefined): void {
  commandSucceeded = succeeded;
}

/**
 * Check completed timings against budgets and emit warnings to stderr
 * for any phase that exceeds its budget. Called automatically after
 * persisting timings.
 *
 * Epic 98 e98.W5.P2: the `total` budget consults
 * `effectiveTotalBudgetMs()` so resource-types with AWS-inherent
 * long completion windows (e.g. SQS apply at 73-74s) don't trip the
 * 60s rule. Other phases (mcp-startup, cli-parse, etc.) are
 * unchanged — they measure CLI cold-start, not AWS-side latency.
 *
 * Wave 3 (DF-PLAN-BUDGET-WARNING-AFTER-SUCCESS): the `total` warning
 * is also suppressed when `commandSucceeded === true` — a slow but
 * successful command is not a UX failure the user needs reminding
 * about (the success message itself is the proof of life).
 */
export function checkTimingsAgainstBudgets(): void {
  for (const [timerLabel, budget] of Object.entries(LABEL_TO_BUDGET)) {
    const actualMs = completed.get(timerLabel);
    if (actualMs === undefined) continue;

    // Suppress the `total` warning on successful commands — the only
    // thing a slow success tells the user is "this could be faster",
    // which is not worth a stderr WARNING line above a green outro.
    // Failed / unknown-outcome commands keep the warning so silent
    // hangs / timeouts are still surfaced (the original 60s-rule
    // intent).
    if (timerLabel === "total" && commandSucceeded === true) continue;

    const effectiveBudget =
      timerLabel === "total" ? effectiveTotalBudgetMs() : budget.budgetMs;
    const result = checkTimingBudget(budget.label, actualMs, effectiveBudget);
    if (!result.passed) {
      process.stderr.write(`[assignee] WARNING: ${result.message}\n`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Persistence                                                        */
/* ------------------------------------------------------------------ */

const MAX_ENTRIES = 100;

function getTelemetryDir(home?: string): string {
  return join(home ?? homedir(), ASSIGNEE_DIR, "telemetry");
}

function getTelemetryFile(home?: string): string {
  return join(getTelemetryDir(home), "timing.json");
}

function isTelemetryDisabled(): boolean {
  return process.env[EnvVar.ASSIGNEE_NO_TELEMETRY] === "1";
}

/**
 * Persist current timings to `~/.assignee/telemetry/timing.json`.
 *
 * Appends a new run entry, capped at {@link MAX_ENTRIES}. When
 * `ASSIGNEE_NO_TELEMETRY=1` is set, this is a no-op.
 *
 * @param runId - Unique identifier for this run.
 * @param homeDir - Override home directory (used in tests). Defaults to `os.homedir()`.
 */
export function persistTimings(runId: string, homeDir?: string): void {
  if (isTelemetryDisabled()) return;

  const telemetryDir = getTelemetryDir(homeDir);
  const telemetryFile = getTelemetryFile(homeDir);

  const entry: TimingRun = {
    version: 1,
    runId,
    timestamp: new Date().toISOString(),
    phases: Array.from(completed, ([label, durationMs]) => ({
      label,
      durationMs,
    })),
  };

  let existing: TimingRun[] = [];
  try {
    const raw = readFileSync(telemetryFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      existing = parsed as TimingRun[];
    }
  } catch {
    // File doesn't exist or is malformed — start fresh
  }

  existing.push(entry);

  // Cap at MAX_ENTRIES (keep most recent)
  if (existing.length > MAX_ENTRIES) {
    existing = existing.slice(existing.length - MAX_ENTRIES);
  }

  try {
    mkdirSync(telemetryDir, { recursive: true });
    writeFileSync(telemetryFile, JSON.stringify(existing, null, 2), "utf-8");
  } catch {
    // Best-effort — don't crash the CLI for telemetry issues
  }

  // After persisting, check if any phase exceeded its budget
  checkTimingsAgainstBudgets();
}

/**
 * Reset all in-memory state. Called at the start of every runCommand
 * invocation (so timers from one command don't bleed into the next)
 * AND directly by tests that want a clean slate.
 *
 * Epic 98 e98.W5.P2: also clears the apply resource-type budget
 * context so a prior SQS apply's 90s override doesn't leak into a
 * subsequent plan / doctor run.
 */
export function resetTimings(): void {
  pending.clear();
  completed.clear();
  applyResourceTypes = undefined;
  commandSucceeded = undefined;
}
