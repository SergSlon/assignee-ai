/**
 * Story 108-B-04 — Doctor check: intent-routing miss-rate.
 *
 * Reads `~/.assignee/telemetry-events.jsonl` (last MAX_EVENTS events),
 * computes the fraction of `unsupported` routing decisions, and renders
 * the result in `assignee admin doctor` output.
 *
 * Behaviour:
 *   - File absent or telemetry not enabled → "Telemetry not enabled" (ok).
 *   - File present but 0 valid events → "No routing data available" (ok).
 *   - Miss-rate ≥ 10% → warn.
 *   - Miss-rate < 10% → ok.
 *   - Read error → warn with message.
 *
 * @module
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TELEMETRY_LOG_FILENAME } from "@assignee/core/telemetry";
import type { IntentRoutingEvent } from "@assignee/core/telemetry";
import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { rollup } from "../util.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of recent events to include in the miss-rate window. */
export const MAX_EVENTS = 100;

/** Warn threshold: ≥ WARN_THRESHOLD_PCT miss-rate triggers a WARN. */
export const WARN_THRESHOLD_PCT = 10;

const SECTION_NAME = "Intent routing";

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface IntentRoutingHealthDeps {
  /** Override the `~/.assignee` base directory (for tests). */
  assigneeDir?: string;
  /** Override `readFileSync` for tests. */
  readFile?: (path: string, encoding: BufferEncoding) => string;
  /** Override `existsSync` for tests. */
  exists?: (path: string) => boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse the JSONL content, filter routing events, and return the last
 * `maxEvents` events in file order (oldest first).
 */
export function parseRoutingEvents(
  content: string,
  maxEvents: number,
): IntentRoutingEvent[] {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: IntentRoutingEvent[] = [];

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "eventType" in parsed &&
        (parsed as { eventType: unknown }).eventType === "intent-routing"
      ) {
        events.push(parsed as IntentRoutingEvent);
      }
    } catch {
      // Skip malformed JSON lines.
    }
  }

  // Return the last maxEvents (cap window to most recent data).
  return events.slice(-maxEvents);
}

/**
 * Compute the miss-rate as a percentage string (e.g. "30.0%"), or
 * `null` when the event list is empty.
 */
export function computeMissRate(events: IntentRoutingEvent[]): string | null {
  if (events.length === 0) return null;
  const unsupported = events.filter(
    (e) => e.classifierPath === "unsupported",
  ).length;
  return ((unsupported / events.length) * 100).toFixed(1);
}

// ---------------------------------------------------------------------------
// Public check
// ---------------------------------------------------------------------------

/**
 * Run the intent-routing-health doctor check.
 *
 * Returns a `DoctorSection` — synchronous, does not launch subprocesses.
 */
export function checkIntentRoutingHealth(
  deps: IntentRoutingHealthDeps = {},
): DoctorSection {
  const assigneeDir = deps.assigneeDir ?? join(homedir(), ".assignee");
  const logPath = join(assigneeDir, TELEMETRY_LOG_FILENAME);

  const existsFn = deps.exists ?? existsSync;
  const readFileFn = deps.readFile ?? ((p, e) => readFileSync(p, e));

  const subs: DoctorSubCheck[] = [];

  // ── File absent ──────────────────────────────────────────────────────────
  if (!existsFn(logPath)) {
    subs.push({
      label: "Routing telemetry",
      status: "ok",
      detail:
        "Telemetry not enabled — set ASSIGNEE_TELEMETRY_ADAPTER=local to collect routing data.",
    });
    return { name: SECTION_NAME, status: rollup(subs), subs };
  }

  // ── File present — read and parse ────────────────────────────────────────
  let content: string;
  try {
    content = readFileFn(logPath, "utf8");
  } catch (err) {
    subs.push({
      label: "Routing telemetry",
      status: "warn",
      detail: `Could not read ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { name: SECTION_NAME, status: rollup(subs), subs };
  }

  const events = parseRoutingEvents(content, MAX_EVENTS);

  if (events.length === 0) {
    subs.push({
      label: "Routing telemetry",
      status: "ok",
      detail:
        "No routing data available — file exists but contains no valid intent-routing events.",
    });
    return { name: SECTION_NAME, status: rollup(subs), subs };
  }

  const missRate = computeMissRate(events) ?? "0.0";
  const missRatePct = parseFloat(missRate);
  const status: DoctorSubCheck["status"] =
    missRatePct >= WARN_THRESHOLD_PCT ? "warn" : "ok";

  subs.push({
    label: "Routing miss-rate",
    status,
    detail: `Intent routing miss-rate (last ${events.length} events): ${missRate}%`,
  });

  return { name: SECTION_NAME, status: rollup(subs), subs };
}
