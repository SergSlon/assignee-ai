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
import { exportLogEvent } from "../telemetry/otel-exporter.js";

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
  /**
   * Wave 12 P0: emitted by LlmAdapter after every successful generateText
   * or generateStructured call. Carries the per-call token usage tagged
   * with the calling node's name (callsite). Used to answer "which node
   * is the token hog" — the question that gates SaaS unit economics.
   * Also accumulated process-wide and summarized at end-of-command via
   * TOKEN_USAGE_SUMMARY.
   */
  TOKEN_USAGE: "token_usage",
  /**
   * Wave 12 P0: emitted once at the end of an apply/plan command with
   * the per-callsite breakdown and command total. Look for this entry
   * to answer "what does ONE assignee command cost in tokens".
   */
  TOKEN_USAGE_SUMMARY: "token_usage_summary",
  /**
   * Architect WARNING #5: bulk-destroy silently drops RGTA-returned types
   * that don't match CloudControl's typeName regex (e.g.
   * "AWS::Backup::Recovery-point" with a lowercase hyphen). Logging at
   * INFO surfaces which types were skipped so users can reason about
   * why a given resource wasn't deleted.
   */
  CCAPI_TYPE_DROPPED: "ccapi_type_dropped",
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
 * Default retention window for persistent log files, in days. Files whose
 * date (parsed from the `cli-YYYY-MM-DD[.n].jsonl` filename) is older than
 * `now - retentionDays` are deleted by `pruneOldLogs`. Override via the
 * `ASSIGNEE_LOG_RETENTION_DAYS` env var.
 */
export const DEFAULT_LOG_RETENTION_DAYS = 14;

/**
 * Marker file written inside the log dir after a successful prune so we can
 * throttle the auto-prune path to at most once per 24 hours. File stores an
 * ISO timestamp; mtime is the actual source of truth (cheap to read).
 */
export const LOG_PRUNE_MARKER = ".last-prune";

/** Minimum interval between auto-prunes (24h in ms). */
const AUTO_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the retention window in days. Honors
 * `ASSIGNEE_LOG_RETENTION_DAYS`; falls back to `DEFAULT_LOG_RETENTION_DAYS`
 * for any non-finite / non-positive value (including 0, negatives, NaN,
 * non-numeric strings). A value of e.g. `"7"` means "keep the last 7 days".
 */
export function resolveLogRetentionDays(): number {
  const raw = process.env[EnvVar.ASSIGNEE_LOG_RETENTION_DAYS];
  if (raw === undefined || raw.length === 0) return DEFAULT_LOG_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOG_RETENTION_DAYS;
  }
  return Math.floor(parsed);
}

/**
 * Parse a persistent log filename into its calendar date. Accepts both
 * `cli-YYYY-MM-DD.jsonl` and the numbered rotation form
 * `cli-YYYY-MM-DD.<n>.jsonl`. Returns `null` for anything that doesn't
 * match (including garbage dates that `Date.parse` rejects).
 */
function parseLogFileDate(fileName: string): Date | null {
  const match = /^cli-(\d{4})-(\d{2})-(\d{2})(?:\.\d+)?\.jsonl$/.exec(fileName);
  if (!match) return null;
  const [, y, m, d] = match;
  // Treat the filename day as a UTC midnight instant — matches `formatDay`
  // which slices `Date.toISOString()` and is therefore UTC-based.
  const iso = `${y}-${m}-${d}T00:00:00.000Z`;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const parsed = new Date(ts);
  // Guard against impossible dates like 2026-02-30 that Date.parse silently
  // rolls over — require a round-trip match.
  if (parsed.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return null;
  return parsed;
}

/**
 * Result of a `pruneOldLogs` call. `deleted` counts files successfully
 * removed; `kept` counts files within the retention window; `skipped`
 * counts non-log files in the directory (e.g. the marker file).
 */
export interface PruneResult {
  deleted: number;
  kept: number;
  skipped: number;
}

/**
 * Delete persistent log files older than `retentionDays`. Walks `dir`
 * synchronously, parses each `cli-YYYY-MM-DD[.n].jsonl` filename, and
 * removes any whose date is strictly older than the cutoff
 * (`now - retentionDays * 24h`). ENOENT on the directory itself is a no-op
 * (returns zeroed counts). Per-file unlink failures are swallowed so a
 * single locked file cannot poison a whole prune run.
 *
 * Uses real Date arithmetic, NOT string comparison — retention boundaries
 * across month/year rollovers must be correct.
 */
export function pruneOldLogs(
  dir: string,
  retentionDays: number = resolveLogRetentionDays(),
  now: Date = new Date(),
  options: { dryRun?: boolean } = {},
): PruneResult {
  const result: PruneResult = { deleted: 0, kept: 0, skipped: 0 };
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    // ENOENT / ENOTDIR → prune is a no-op. Anything else: rethrow so the
    // operator sees the permission/IO problem at the `clean` layer.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return result;
    throw err;
  }

  const cutoff = now.getTime() - retentionDays * AUTO_PRUNE_INTERVAL_MS;

  for (const name of entries) {
    const fileDate = parseLogFileDate(name);
    if (fileDate === null) {
      result.skipped++;
      continue;
    }
    if (fileDate.getTime() < cutoff) {
      if (options.dryRun === true) {
        result.deleted++;
        continue;
      }
      try {
        fs.unlinkSync(path.join(dir, name));
        result.deleted++;
      } catch {
        // Best-effort: a single unlink failure (EBUSY, EPERM, race with
        // another process) must not abort the rest of the prune.
        result.skipped++;
      }
    } else {
      result.kept++;
    }
  }
  return result;
}

/**
 * Read the marker file's mtime. Returns `null` if the marker is absent or
 * unreadable — callers treat a missing marker as "never pruned before".
 */
function readMarkerTime(dir: string): number | null {
  try {
    const stat = fs.statSync(path.join(dir, LOG_PRUNE_MARKER));
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

/** Touch the marker file so the next auto-prune waits 24h. Best-effort. */
function touchMarker(dir: string, now: Date): void {
  try {
    fs.writeFileSync(path.join(dir, LOG_PRUNE_MARKER), now.toISOString(), {
      mode: 0o600,
    });
  } catch {
    // Marker write failed — next run will simply re-prune. Non-fatal.
  }
}

/**
 * Auto-prune throttled to at most once per 24h, gated by the marker file.
 * Intended for callers on warm paths (e.g. the CLI bootstrap) that want the
 * retention guarantee without paying the readdir cost on every invocation.
 *
 * Returns the `PruneResult` if a prune actually ran, or `null` if the
 * marker indicates a prune happened within the interval. ENOENT on the dir
 * is a no-op (returns `null`).
 */
export function autoPruneLogsIfDue(
  dir: string,
  retentionDays: number = resolveLogRetentionDays(),
  now: Date = new Date(),
): PruneResult | null {
  // Dir missing → nothing to do.
  try {
    fs.statSync(dir);
  } catch {
    return null;
  }
  const last = readMarkerTime(dir);
  if (last !== null && now.getTime() - last < AUTO_PRUNE_INTERVAL_MS) {
    return null;
  }
  const result = pruneOldLogs(dir, retentionDays, now);
  touchMarker(dir, now);
  return result;
}

/** Exposed for tests and for the `clean` command. */
export function getLogDir(): string {
  return resolveLogDir();
}

/**
 * Resolve the active log file path for `day`, rotating to a numbered suffix
 * if the base file exceeds the size limit. Walks counters until it finds a
 * file under the cap (or one that doesn't exist yet). Never deletes old files
 * during rotation — retention is handled by `pruneOldLogs` / `clean --logs`.
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
 * Precedence (highest-priority first):
 *   1. `--verbose` CLI flag (registered as a global option on the root
 *      `assignee` program in apps/cli/src/index.ts). The flag is also
 *      propagated into `ASSIGNEE_LOG_LEVEL=debug` via a `preSubcommand` hook
 *      so child processes and MCP servers inherit the verbose setting.
 *   2. `ASSIGNEE_LOG_LEVEL=debug` environment variable
 *   3. `ASSIGNEE_VERBOSITY=verbose` environment variable
 *
 * The CLI flag always wins: setting `--verbose` enables verbose mode even
 * when the env vars are unset or set to a non-verbose value.
 *
 * Without an explicit opt-in, info-level structured logs are suppressed so
 * they never leak into stdout/stderr and pollute user-facing output.
 * error/warn events are persisted regardless — see `appendPersistent`.
 */
function isVerbose(): boolean {
  // CLI flag wins — scan process.argv directly so the check works even when
  // called before commander has finished parsing (e.g. from module-level
  // bootstrap code that runs before `program.parseAsync`).
  if (process.argv.includes("--verbose")) return true;
  const logLevel = process.env[EnvVar.ASSIGNEE_LOG_LEVEL];
  if (logLevel === "debug") return true;
  const verbosity = process.env[EnvVar.ASSIGNEE_VERBOSITY];
  if (verbosity === "verbose") return true;
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
 * Wave 19 Bug #4: info-level events that MUST be persisted to disk regardless
 * of verbose mode. Listed here because the original logger design said
 * "info: never persisted" but Wave 12's TOKEN_USAGE_SUMMARY is supposed to be
 * the canonical "what did this command cost in tokens" answer, and
 * `feedback_token_cost_visibility.md` explicitly says it must be greppable
 * from the persistent log file. Without this allowlist a user wanting to
 * answer "what did this week of `assignee` runs cost" has to scrape terminal
 * scrollback, which defeats the purpose of the instrumentation entirely.
 *
 * Add new entries here only if the same "must be queryable after the fact"
 * justification applies — do NOT use this allowlist as a back-door to
 * persist debug noise.
 */
const PERSIST_INFO_ALLOWLIST: ReadonlySet<string> = new Set([
  LOG_ACTIONS.TOKEN_USAGE_SUMMARY,
]);

/**
 * Writes a structured JSON log event.
 *
 * Behaviour by level:
 *   - error / warn: ALWAYS appended to the rotating daily log file. Also
 *     emitted to stderr when verbose mode is enabled.
 *   - info: emitted to stderr only when verbose mode is enabled. Persisted
 *     to disk only when `event.action` is in PERSIST_INFO_ALLOWLIST (Wave 19
 *     Bug #4 — TOKEN_USAGE_SUMMARY needs greppable cost telemetry).
 *
 * Verbose mode is triggered by `--verbose`, `ASSIGNEE_VERBOSITY=verbose`, or
 * `ASSIGNEE_LOG_LEVEL=debug`.
 *
 * @param event - The log event to write
 */
export function log(event: LogEvent): void {
  const verbose = isVerbose();
  const isWarnOrError =
    event.level === LogLevel.ERROR || event.level === LogLevel.WARN;
  const isPersistInfo =
    event.level === LogLevel.INFO && PERSIST_INFO_ALLOWLIST.has(event.action);

  if (isWarnOrError || isPersistInfo) {
    appendPersistent(event);
  }

  if (verbose) {
    process.stderr.write(JSON.stringify(event) + "\n");
  }

  // M-6.4 / OTEL exporter: when ASSIGNEE_OTEL_ENDPOINT is set, mirror this
  // event to the OTLP/HTTP-JSON v1/logs endpoint. The exporter is fire-
  // and-forget and never throws — see telemetry/otel-exporter.ts. Use
  // void to explicitly discard the promise so log() stays synchronous.
  void exportLogEvent(event);
}
