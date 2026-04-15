/**
 * Dry-run counter for checkpoint pruning.
 *
 * Duplicates the filter logic of `pruneExpiredCheckpoints` in read-only
 * mode so the orchestrator can preview how many files WOULD be pruned
 * without mutating the filesystem.
 *
 * @see Story 33.2
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CHECKPOINT_FILE_PREFIX,
  CLEANUP_SKIP_RECENT_MINUTES,
} from "../../config/constants.js";

interface Info {
  createdAt: number;
  expired: boolean;
  mtime: number;
}

/**
 * For dry-run mode: count how many checkpoint files would be pruned without deleting.
 * Duplicates the logic of pruneExpiredCheckpoints in read-only mode.
 */
export async function dryRunCheckpoints(
  dir: string,
): Promise<{ pruned: number; kept: number }> {
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
  const infos: Info[] = [];

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
      const ttlHours = typeof json.ttl_hours === "number" ? json.ttl_hours : 72;
      expired = now > createdAt + ttlHours * 60 * 60 * 1000;
    } catch {
      createdAt = 0;
      expired = true;
      mtime = 0;
    }
    infos.push({ createdAt, expired, mtime });
  }

  infos.sort((a, b) => b.createdAt - a.createdAt);

  let pruned = 0;
  let kept = 0;
  const skipRecentMs = CLEANUP_SKIP_RECENT_MINUTES * 60 * 1000;

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i]!;
    if (i < 3) {
      kept++;
    } else if (now - info.mtime < skipRecentMs) {
      kept++;
    } else if (!info.expired) {
      kept++;
    } else {
      pruned++;
    }
  }

  return { pruned, kept };
}
