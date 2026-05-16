/**
 * Story 108-B-04 — Local JSONL telemetry log writer.
 *
 * Appends `IntentRoutingEvent` objects as newline-delimited JSON to
 * `~/.assignee/telemetry-events.jsonl`. The write is:
 *
 *   - Append-only (never truncates the file — AC-2: two runs → two entries).
 *   - Non-blocking to the caller: errors are swallowed and logged at
 *     debug level (AC-7: write errors must not crash or degrade the plan).
 *   - Guarded by the `ASSIGNEE_TELEMETRY_ADAPTER=local` opt-in env var
 *     (AC-4: no file creation without opt-in).
 *   - Creates `~/.assignee/` directory if absent (AC-6: missing dir handled).
 *
 * @module
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { log, LOG_ACTIONS } from "../utils/logger/index.js";
import { EnvVar } from "../constants/env-vars.js";
import type { IntentRoutingEvent } from "./telemetry-event-schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Environment variable that enables local telemetry persistence. */
export const TELEMETRY_ADAPTER_ENV = EnvVar.ASSIGNEE_TELEMETRY_ADAPTER;

/** The value that activates the local-file adapter. */
export const LOCAL_ADAPTER_VALUE = "local";

/** Directory under `~` where telemetry data is stored. */
const ASSIGNEE_DIR_NAME = ".assignee";

/** Filename for the persistent JSONL routing telemetry log. */
export const TELEMETRY_LOG_FILENAME = "telemetry-events.jsonl";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return `true` when the local telemetry adapter is opted in via the
 * `ASSIGNEE_TELEMETRY_ADAPTER=local` env var.
 *
 * Used by the intent-parser node to gate the write call so no I/O
 * happens when the user has not explicitly opted in (AC-4).
 */
export function isTelemetryEnabled(): boolean {
  return process.env[TELEMETRY_ADAPTER_ENV] === LOCAL_ADAPTER_VALUE;
}

/**
 * Resolve the full path to the telemetry JSONL file.
 *
 * @param assigneeDir - Override the `~/.assignee` base directory (for tests).
 */
export function resolveTelemetryLogPath(assigneeDir?: string): string {
  const base = assigneeDir ?? join(homedir(), ASSIGNEE_DIR_NAME);
  return join(base, TELEMETRY_LOG_FILENAME);
}

/**
 * Append a single `IntentRoutingEvent` to the local telemetry JSONL log.
 *
 * Behaviour:
 *  - Creates `~/.assignee/` directory if absent (AC-6).
 *  - Appends `JSON.stringify(event) + "\n"` — append-only, never truncates.
 *  - Any I/O error is swallowed; a debug-level log entry is emitted instead.
 *    The caller's routing result is unaffected (AC-7).
 *  - No-op when `ASSIGNEE_TELEMETRY_ADAPTER` is not `"local"`.
 *    Callers SHOULD check `isTelemetryEnabled()` before calling to avoid
 *    the directory-stat overhead, but this function is safe to call
 *    unconditionally as a double-guard.
 *
 * @param event      - The routing event to persist.
 * @param runId      - Optional run ID for log correlation.
 * @param assigneeDir - Override the base directory (for tests).
 * @param fsAppend   - Override `appendFile` for tests (Axis I injection).
 * @param fsMkdir    - Override `mkdir` for tests (Axis I injection).
 */
export async function appendRoutingEvent(
  event: IntentRoutingEvent,
  runId?: string,
  assigneeDir?: string,
  fsAppend: (path: string, data: string) => Promise<void> = appendFile,
  fsMkdir: (
    path: string,
    opts: { recursive: boolean },
  ) => Promise<unknown> = mkdir,
): Promise<void> {
  if (!isTelemetryEnabled()) {
    return;
  }

  const logPath = resolveTelemetryLogPath(assigneeDir);
  const dirPath = join(logPath, "..");

  try {
    // Ensure directory exists — no-op when already present.
    await fsMkdir(dirPath, { recursive: true });
    // Append the event as a single JSON line.
    const line = JSON.stringify(event) + "\n";
    await fsAppend(logPath, line);
  } catch (err) {
    // Swallow — write errors MUST NOT degrade the plan output (AC-7).
    log({
      ts: new Date().toISOString(),
      runId: runId ?? "",
      level: "debug",
      action: LOG_ACTIONS.TELEMETRY_EMIT,
      extras: {
        error: err instanceof Error ? err.message : String(err),
        logPath,
      },
    });
  }
}
