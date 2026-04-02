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
import { STARTUP_BUDGETS, checkBudget } from "../constants/time-budget.js";
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
  total: STARTUP_BUDGETS.TOTAL_COLD_START,
};

/**
 * Check completed timings against budgets and emit warnings to stderr
 * for any phase that exceeds its budget. Called automatically after
 * persisting timings.
 */
export function checkTimingsAgainstBudgets(): void {
  for (const [timerLabel, budget] of Object.entries(LABEL_TO_BUDGET)) {
    const actualMs = completed.get(timerLabel);
    if (actualMs === undefined) continue;

    const result = checkBudget(budget.label, actualMs, budget.budgetMs);
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
 * Reset all in-memory state. Intended for tests only.
 */
export function resetTimings(): void {
  pending.clear();
  completed.clear();
}
