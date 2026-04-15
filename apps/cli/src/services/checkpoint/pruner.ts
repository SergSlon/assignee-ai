/**
 * Checkpoint pruner — deletes expired checkpoints from disk while keeping
 * the N-newest regardless and skipping recently-modified files to avoid
 * racing in-flight writers.
 *
 * Extracted from checkpoint.ts during Wave-6c decomposition.
 *
 * @see Story 33.2
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CHECKPOINT_FILE_PREFIX,
  CLEANUP_SKIP_RECENT_MINUTES,
} from "../../config/constants.js";

/** How many newest checkpoints to always keep, regardless of TTL. */
const KEEP_NEWEST_COUNT = 3;

/** Default TTL in hours used when the file's ttl_hours field is unreadable. */
const DEFAULT_FALLBACK_TTL_HOURS = 72;

interface FileInfo {
  filePath: string;
  createdAt: number;
  expired: boolean;
  mtime: number;
}

/**
 * Prunes expired checkpoint files from a directory.
 * Keeps the 3 newest checkpoints regardless of expiry, and skips recently
 * modified files so that a concurrent writer isn't stomped.
 *
 * @param dir - Directory containing checkpoint-*.json files.
 * @param opts.skipRecentMinutes - Skip files modified within this many minutes.
 * @returns Count of pruned and kept files.
 */
export async function pruneExpiredCheckpoints(
  dir: string,
  opts: { skipRecentMinutes?: number } = {},
): Promise<{ pruned: number; kept: number }> {
  const skipRecentMs =
    (opts.skipRecentMinutes ?? CLEANUP_SKIP_RECENT_MINUTES) * 60 * 1000;

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { pruned: 0, kept: 0 };
  }

  const files = entries.filter(
    (f) => f.startsWith(CHECKPOINT_FILE_PREFIX) && f.endsWith(".json"),
  );
  if (files.length === 0) return { pruned: 0, kept: 0 };

  const now = Date.now();
  const infos = await collectFileInfos(dir, files, now);

  // Sort newest first
  infos.sort((a, b) => b.createdAt - a.createdAt);

  let pruned = 0;
  let kept = 0;

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i]!;
    // Keep the 3 newest regardless
    if (i < KEEP_NEWEST_COUNT) {
      kept++;
    } else if (now - info.mtime < skipRecentMs) {
      kept++;
    } else if (!info.expired) {
      kept++;
    } else {
      // Prune this file
      try {
        await fs.unlink(info.filePath);
        pruned++;
      } catch {
        kept++; // Failed to delete — count as kept
      }
    }
  }

  return { pruned, kept };
}

/** Read each candidate file's mtime + parsed created_at / ttl_hours. */
async function collectFileInfos(
  dir: string,
  files: string[],
  now: number,
): Promise<FileInfo[]> {
  const infos: FileInfo[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    let mtime: number;
    try {
      const stat = await fs.stat(filePath);
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    let createdAt: number;
    let expired: boolean;
    try {
      const json = JSON.parse(raw);
      createdAt = new Date(json.created_at).getTime();
      const ttlHours =
        typeof json.ttl_hours === "number"
          ? json.ttl_hours
          : DEFAULT_FALLBACK_TTL_HOURS;
      expired = now > createdAt + ttlHours * 60 * 60 * 1000;
    } catch {
      createdAt = 0;
      expired = true;
      mtime = 0;
    }
    infos.push({ filePath, createdAt, expired, mtime });
  }

  return infos;
}
