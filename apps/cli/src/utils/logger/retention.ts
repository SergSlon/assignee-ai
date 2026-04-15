/**
 * Log retention: prune old daily log files based on a rolling day window.
 * Extracted from logger.ts (Wave 6d F5).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { EnvVar } from "../../constants/env-vars.js";

/**
 * Default retention window for persistent log files, in days.
 */
export const DEFAULT_LOG_RETENTION_DAYS = 14;

/**
 * Marker file written inside the log dir after a successful prune so we can
 * throttle the auto-prune path to at most once per 24 hours.
 */
export const LOG_PRUNE_MARKER = ".last-prune";

/** Minimum interval between auto-prunes (24h in ms). */
const AUTO_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the retention window in days. Honors ASSIGNEE_LOG_RETENTION_DAYS;
 * falls back to DEFAULT_LOG_RETENTION_DAYS for any non-finite / non-positive
 * value (including 0, negatives, NaN, non-numeric strings).
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
 * `cli-YYYY-MM-DD.<n>.jsonl`. Returns `null` for anything else.
 */
function parseLogFileDate(fileName: string): Date | null {
  const match = /^cli-(\d{4})-(\d{2})-(\d{2})(?:\.\d+)?\.jsonl$/.exec(fileName);
  if (!match) return null;
  const [, y, m, d] = match;
  const iso = `${y}-${m}-${d}T00:00:00.000Z`;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const parsed = new Date(ts);
  // Guard against impossible dates like 2026-02-30 that Date.parse silently
  // rolls over — require a round-trip match.
  if (parsed.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return null;
  return parsed;
}

export interface PruneResult {
  deleted: number;
  kept: number;
  skipped: number;
}

/**
 * Delete persistent log files older than `retentionDays`. Walks `dir`
 * synchronously, parses each `cli-YYYY-MM-DD[.n].jsonl` filename, and
 * removes any whose date is strictly older than the cutoff.
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
        // Best-effort: a single unlink failure must not abort the whole prune.
        result.skipped++;
      }
    } else {
      result.kept++;
    }
  }
  return result;
}

/** Read the marker file's mtime. Returns null if absent or unreadable. */
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
 *
 * Returns the PruneResult if a prune actually ran, or null if the marker
 * indicates a prune happened within the interval. ENOENT on the dir is a
 * no-op (returns null).
 */
export function autoPruneLogsIfDue(
  dir: string,
  retentionDays: number = resolveLogRetentionDays(),
  now: Date = new Date(),
): PruneResult | null {
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
