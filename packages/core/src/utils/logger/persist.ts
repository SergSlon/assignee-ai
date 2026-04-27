/**
 * Log persistence (stderr console + daily rotating file + OTLP mirror).
 *
 * Lifted from `apps/cli/src/utils/logger/persist.ts` in Story 50-4
 * Wave 5 Pass A.
 *
 * ⚠️ INVARIANT (Epic 92 Wave 2.c — A-21 / B-14): this module MUST
 * write structured log events to `process.stderr` ONLY. Under
 * `--output json` the CLI reserves `process.stdout` for a single
 * parseable JSON envelope; a stray logger write would shred the
 * stream. The invariant is locked in by the regression tests
 * `logger.test.ts › invariant — log() never writes to stdout`.
 */
import * as fs from "node:fs";
import { EnvVar } from "../../constants/env-vars.js";
import { exportLogEvent } from "../../telemetry/otel-exporter.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../../config/config-port.js";
import { LOG_ACTIONS, LogLevel, type LogEvent } from "./actions.js";
import {
  ensureLogDirCached,
  formatDay,
  resolveActiveLogFile,
  resolveLogDir,
} from "./paths.js";

/**
 * Returns true when the user has opted-in to verbose / structured log output.
 *
 * Precedence (highest-priority first):
 *   1. `--verbose` CLI flag (registered as a global option in apps/cli/src/index.ts).
 *      The flag is also propagated into `ASSIGNEE_LOG_LEVEL=debug` via a
 *      `preSubcommand` hook so child processes and MCP servers inherit the
 *      verbose setting.
 *   2. `ASSIGNEE_LOG_LEVEL=debug` environment variable
 *   3. `ASSIGNEE_VERBOSITY=verbose` environment variable
 */
function isVerbose(config?: ConfigPort): boolean {
  // CLI flag wins — scan process.argv directly so the check works even when
  // called before commander has finished parsing.
  if (process.argv.includes("--verbose")) return true;
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  const logLevel = effectiveConfig.get(EnvVar.ASSIGNEE_LOG_LEVEL);
  if (logLevel === "debug") return true;
  const verbosity = effectiveConfig.get(EnvVar.ASSIGNEE_VERBOSITY);
  if (verbosity === "verbose") return true;
  return false;
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
    ensureLogDirCached(dir);
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
 * of verbose mode. feedback_token_cost_visibility.md says TOKEN_USAGE_SUMMARY
 * must be greppable from the persistent log file. Without this allowlist a
 * user wanting to answer "what did this week of `assignee` runs cost" has to
 * scrape terminal scrollback.
 *
 * Add new entries here only if the same "must be queryable after the fact"
 * justification applies.
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
 *     to disk only when `event.action` is in PERSIST_INFO_ALLOWLIST.
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
  // event to the OTLP/HTTP-JSON v1/logs endpoint. Fire-and-forget; `void`
  // explicitly discards the promise so log() stays synchronous.
  void exportLogEvent(event);
}
