/**
 * Structured JSON logger for the Assignee.ai CLI.
 * All operational logs are written to stderr as single-line JSON.
 * stdout is reserved for user-facing output (plan boxes, prompts).
 *
 * error/warn events are ALWAYS persisted to a rotating daily file under
 * ~/.assignee/logs/cli-YYYY-MM-DD.jsonl (override with ASSIGNEE_LOG_DIR) so
 * the CLI keeps an audit trail even without --verbose.
 *
 * @see NFR-12 — Structured Logging requirement
 * @see Story 9.6 — L2: LogAction exhaustive union; LogEvent index signature removed
 * @see SECURITY-AUDIT.md — H19 (silent error drop)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EnvVar } from "../constants/env-vars.js";

export const LOG_ACTIONS = {
  PLAN_STARTED: "plan_started",
  INTENT_PARSED: "intent_parsed",
  PLAN_COMPLETE: "plan_complete",
  SCHEMA_FETCHED: "schema_fetched",
  GUARDRAIL_DISABLED: "guardrail_disabled",
  PLAN_GENERATED: "plan_generated",
  PREFLIGHT_COMPLETED: "preflight_completed",
  PRICING_UNAVAILABLE: "pricing_unavailable",
  PRICING_TIMEOUT: "pricing_timeout",
  PLAN_APPROVED: "plan_approved",
  PLAN_REJECTED: "plan_rejected_by_user",
  APPLY_STARTED: "apply_started",
  APPLY_COMPLETE: "apply_complete",
  STATE_GUARD_ABORT: "state_guard_abort",
  STATE_GUARD_SKIPPED: "state_guard_skipped",
  STATE_GUARD_SKIPPED_UNRESOLVED_IDENTIFIER:
    "state_guard_skipped_unresolved_identifier",
  RESOURCE_PROVISION_STARTED: "resource_provision_started",
  PROVISIONING_STATUS_CHECKED: "provisioning_status_checked",
  RESULT_FORMATTED: "result_formatted",
  APPLY_SUCCEEDED: "apply_succeeded",
  APPLY_FAILED: "apply_failed",
  CHECKPOINT_SAVED: "checkpoint_saved",
  CHECKPOINT_LOADED: "checkpoint_loaded",
  CHECKPOINT_EXPIRED: "checkpoint_expired",
  PLAN_TO_APPLY_STARTED: "plan_to_apply_started",
  PLAN_TO_APPLY_DECLINED: "plan_to_apply_declined",
  CONFIG_LOADED: "config_loaded",
  ORG_POLICY_FETCHED: "org_policy_fetched",
  SDK_FALLBACK_DISPATCHED: "sdk_fallback_dispatched",
  FREE_TIER_DETECTED: "free_tier_detected",
  BP_EVALUATED: "bp_evaluated",
  BP_EVALUATION_SKIPPED: "bp_evaluation_skipped",
  APPLY_AUTO_APPROVED: "apply_auto_approved",
  IAM_CHECK_SKIPPED: "iam_check_skipped",
  SECURITY_CHECK_SKIPPED: "security_check_skipped",
  MEMORY_WRITE_FAILED: "memory_write_failed",
  OPTION_ELICITED: "option_elicited",
  FIX_APPLIED: "fix_applied",
  PROVISION_LOOP_EXCEEDED: "provision_loop_exceeded",
  MCP_OPTIONAL_INIT_FAILED: "mcp_optional_init_failed",
  ADVICE_GENERATED: "advice_generated",
  ADVICE_SKIPPED: "advice_skipped",
} as const;

export type LogAction = (typeof LOG_ACTIONS)[keyof typeof LOG_ACTIONS];

export const LogLevel = {
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

export type LogLevelType = (typeof LogLevel)[keyof typeof LogLevel];

export interface LogEvent {
  ts: string;
  runId: string;
  level: LogLevelType;
  action: LogAction;
  durationMs?: number;
  result?: string;
  extras?: Record<string, unknown>;
}

/** Environment variable to redirect persistent logs (used by tests). */
const LOG_DIR_ENV = "ASSIGNEE_LOG_DIR";

/**
 * Soft size cap for the daily log file. When the active file exceeds this
 * size, subsequent writes go to a numbered rotation (cli-YYYY-MM-DD.<n>.jsonl)
 * so a single hot run can't grow one file unboundedly.
 *
 * Default: 10 MiB. Override for tests via setLogFileSizeLimitForTests().
 */
export const LOG_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
let logFileSizeLimitBytes = LOG_FILE_SIZE_LIMIT_BYTES;

/**
 * Module-level cache of directories we've already created via mkdirSync, so
 * the persistent-log hot path skips the syscall after the first event in any
 * given directory. (REG-N9)
 *
 * The cache is intentionally process-scoped: a long compound apply emits
 * thousands of events to the same dir and the mkdirSync overhead is wasted
 * I/O. The first call still mkdirs (recursive: true) so a deleted-mid-run
 * directory will recreate on the next event after the cache is cleared.
 */
const ensuredDirs = new Set<string>();

/**
 * Test-only helpers — override the size limit and clear the dir cache so
 * tests can simulate rotation without writing 10 MiB.
 */
export function setLogFileSizeLimitForTests(limitBytes: number): void {
  logFileSizeLimitBytes = limitBytes;
}
export function resetLogFileSizeLimitForTests(): void {
  logFileSizeLimitBytes = LOG_FILE_SIZE_LIMIT_BYTES;
}
export function clearEnsuredDirCacheForTests(): void {
  ensuredDirs.clear();
}

/**
 * Resolve the active log file path for `day`, rotating to a numbered suffix
 * if the base file exceeds the size limit. Walks counters until it finds a
 * file under the cap (or one that doesn't exist yet). Never deletes old files
 * — that's a separate operator concern.
 */
function resolveActiveLogFile(dir: string, day: string): string {
  const baseName = `cli-${day}.jsonl`;
  const basePath = path.join(dir, baseName);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(basePath);
  } catch {
    return basePath;
  }
  if (stat.size < logFileSizeLimitBytes) return basePath;

  // Base file is at/over cap — find the next available numbered slot.
  for (let n = 1; n < 10_000; n++) {
    const rotated = path.join(dir, `cli-${day}.${n}.jsonl`);
    let rotStat: fs.Stats | undefined;
    try {
      rotStat = fs.statSync(rotated);
    } catch {
      // Doesn't exist — this is our slot.
      return rotated;
    }
    if (rotStat.size < logFileSizeLimitBytes) return rotated;
  }
  // Pathological: 10 000 rotations all full. Fall back to the last one;
  // operator-level cleanup is required at that point.
  return path.join(dir, `cli-${day}.9999.jsonl`);
}

/**
 * Returns true when the user has opted-in to verbose / structured log output.
 *
 * Checked (in priority order):
 *   1. `--verbose` CLI flag
 *   2. `ASSIGNEE_VERBOSITY=verbose` environment variable
 *   3. `ASSIGNEE_LOG_LEVEL=debug` environment variable
 *
 * Without an explicit opt-in, info-level structured logs are suppressed so
 * they never leak into stdout/stderr and pollute user-facing output.
 * error/warn events are persisted regardless — see `appendPersistent`.
 */
function isVerbose(): boolean {
  if (process.argv.includes("--verbose")) return true;
  const verbosity = process.env[EnvVar.ASSIGNEE_VERBOSITY];
  if (verbosity === "verbose") return true;
  const logLevel = process.env[EnvVar.ASSIGNEE_LOG_LEVEL];
  if (logLevel === "debug") return true;
  return false;
}

/**
 * Resolve the directory where error/warn events should be persisted.
 * Honors ASSIGNEE_LOG_DIR (used by tests to isolate from the developer's
 * real ~/.assignee/logs), otherwise falls back to ~/.assignee/logs.
 */
function resolveLogDir(): string {
  const override = process.env[LOG_DIR_ENV];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".assignee", "logs");
}

/** Format a Date as YYYY-MM-DD in UTC for the daily log file name. */
function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Persist an error/warn event to ~/.assignee/logs/cli-YYYY-MM-DD.jsonl.
 * Best-effort: on any failure (disk full, permission denied, EACCES) falls
 * back to stderr and never throws.
 */
function appendPersistent(event: LogEvent): void {
  const dir = resolveLogDir();
  const line = JSON.stringify(event) + "\n";
  try {
    // REG-N9: Skip the mkdirSync syscall once we've already created `dir`
    // in this process. Long compound applies emit thousands of warn/error
    // events to the same directory; the first call still mkdirs (recursive)
    // so missing parents are created.
    if (!ensuredDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      ensuredDirs.add(dir);
    }
    const filePath = resolveActiveLogFile(dir, formatDay(new Date()));
    fs.appendFileSync(filePath, line, { flag: "a", mode: 0o600 });
  } catch (err) {
    // Fall back to stderr so the event is not silently dropped. Include the
    // underlying cause so the operator can diagnose the log-directory issue.
    try {
      process.stderr.write(
        JSON.stringify({
          ...event,
          extras: {
            ...(event.extras ?? {}),
            persistentLogFallback: String(err),
          },
        }) + "\n",
      );
    } catch {
      // Stderr itself failed — nothing we can do.
    }
  }
}

/**
 * Writes a structured JSON log event.
 *
 * Behaviour by level:
 *   - error / warn: ALWAYS appended to the rotating daily log file. Also
 *     emitted to stderr when verbose mode is enabled.
 *   - info: emitted to stderr only when verbose mode is enabled; never
 *     persisted to disk.
 *
 * Verbose mode is triggered by `--verbose`, `ASSIGNEE_VERBOSITY=verbose`, or
 * `ASSIGNEE_LOG_LEVEL=debug`.
 *
 * @param event - The log event to write
 */
export function log(event: LogEvent): void {
  const verbose = isVerbose();
  const isPersistent =
    event.level === LogLevel.ERROR || event.level === LogLevel.WARN;

  if (isPersistent) {
    appendPersistent(event);
  }

  if (verbose) {
    process.stderr.write(JSON.stringify(event) + "\n");
  }
}
