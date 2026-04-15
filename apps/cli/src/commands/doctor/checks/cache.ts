/**
 * Doctor check #4 — local cache health (~/.assignee).
 *
 * Read-only inspection: total size, oldest-checkpoint age, log file
 * count. Never deletes anything (use `assignee clean` for that).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { ASSIGNEE_DIR } from "@assignee/core";
import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { rollup } from "../util.js";

export interface CacheCheckDeps {
  homeDir?: string;
}

export function checkCache(deps: CacheCheckDeps = {}): DoctorSection {
  const home = deps.homeDir ?? join(os.homedir(), ASSIGNEE_DIR);
  const subs: DoctorSubCheck[] = [];

  if (!existsSync(home)) {
    subs.push({
      label: home,
      status: "warn",
      detail: "directory does not exist (will be created on first run)",
    });
    return { name: "Cache", status: "warn", subs };
  }

  const totalBytes = walkDirSize(home);
  const checkpoints = listCheckpoints(home);
  const logCount = countLogs(join(home, "logs"));

  const oldestCheckpointAgeHours =
    checkpoints.length === 0
      ? 0
      : Math.floor(
          (Date.now() - Math.min(...checkpoints.map((c) => c.mtimeMs))) /
            (1000 * 60 * 60),
        );

  // Stale = older than 72h (default checkpoint TTL).
  const staleCheckpoints = checkpoints.filter(
    (c) => Date.now() - c.mtimeMs > 72 * 60 * 60 * 1000,
  ).length;

  const summary =
    `${formatBytes(totalBytes)}, ${staleCheckpoints} stale checkpoints, ${logCount} log files` +
    (oldestCheckpointAgeHours > 0
      ? `, oldest checkpoint ${oldestCheckpointAgeHours}h`
      : "");

  subs.push({
    label: home,
    status: staleCheckpoints > 0 ? "warn" : "ok",
    detail: summary,
  });

  return {
    name: "Cache",
    status: rollup(subs),
    subs,
  };
}

/** Recursively sum file sizes under `dir`. Errors are silently ignored. */
function walkDirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          total += walkDirSize(p);
        } else if (entry.isFile()) {
          total += statSync(p).size;
        }
      } catch {
        // Skip unreadable entries.
      }
    }
  } catch {
    // Skip unreadable directories.
  }
  return total;
}

/** List checkpoint files (`checkpoint-*.json`) under `dir`. */
function listCheckpoints(
  dir: string,
): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.startsWith("checkpoint-") &&
        entry.name.endsWith(".json")
      ) {
        const p = join(dir, entry.name);
        try {
          out.push({ path: p, mtimeMs: statSync(p).mtimeMs });
        } catch {
          // Skip — race with concurrent cleanup.
        }
      }
    }
  } catch {
    // Directory missing — return empty list.
  }
  return out;
}

/** Count `.jsonl` files under the logs subdir. */
function countLogs(logsDir: string): number {
  try {
    return readdirSync(logsDir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

/** Format a byte count as KB / MB / GB with one decimal. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
