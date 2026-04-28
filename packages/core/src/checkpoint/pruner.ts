/**
 * Checkpoint pruner — deletes expired checkpoints from disk while keeping
 * the N-newest regardless and skipping recently-modified files to avoid
 * racing in-flight writers.
 *
 * Extracted from apps/cli during Wave-6c; promoted to @assignee/core by
 * Story 50-4 so apps/mcp-server and apps/cli share one pruning
 * implementation.
 *
 * RW4d-migration-A (M-016): now accepts an optional `StoragePort` to
 * decouple from `node:fs` for the read/list/delete operations.
 *
 * FLAG (port extension needed): the `skipRecentMinutes` guard reads
 * `fs.stat(filePath).mtimeMs` to detect concurrent writers. The
 * StoragePort interface does NOT yet expose file-mtime metadata. For
 * now the pruner reads mtime directly via `node:fs` regardless of
 * which port is supplied — this is an fs-only concern, and the only
 * port-backed callers in the current tree pass a `LocalFsStorageAdapter`
 * whose data is on the same filesystem. Future remote adapters
 * (S3 / DDB) will need StoragePort to grow a `stat(key)` /
 * `LastModified` accessor before this guard can be honoured cleanly.
 *
 * @see Story 33.2
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CHECKPOINT_FILE_PREFIX,
  CHECKPOINT_CLEANUP_SKIP_RECENT_MINUTES,
} from "./constants.js";
import { LocalFsStorageAdapter } from "../adapters/storage/local-fs-adapter.js";
import type { StoragePort } from "../ports/storage-port.js";

/** How many newest checkpoints to always keep, regardless of TTL. */
const KEEP_NEWEST_COUNT = 3;

/** Default TTL in hours used when the file's ttl_hours field is unreadable. */
const DEFAULT_FALLBACK_TTL_HOURS = 72;

interface FileInfo {
  /** Storage key (filename relative to the rootDir). */
  key: string;
  /** Absolute filesystem path — kept for fs.stat / unlink legacy path. */
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
 * @param opts.storage - TODO(SaaS): explicit StoragePort. When omitted the
 *   pruner builds a `LocalFsStorageAdapter` rooted at `dir`.
 * @returns Count of pruned and kept files.
 */
export async function pruneExpiredCheckpoints(
  dir: string,
  opts: {
    skipRecentMinutes?: number;
    // TODO(SaaS): require StoragePort once all callers thread it through.
    storage?: StoragePort;
  } = {},
): Promise<{ pruned: number; kept: number }> {
  const skipRecentMs =
    (opts.skipRecentMinutes ?? CHECKPOINT_CLEANUP_SKIP_RECENT_MINUTES) *
    60 *
    1000;

  const port = opts.storage ?? new LocalFsStorageAdapter({ rootDir: dir });

  let entries: string[];
  try {
    entries = await port.list();
  } catch {
    return { pruned: 0, kept: 0 };
  }

  const files = entries.filter(
    (f) => f.startsWith(CHECKPOINT_FILE_PREFIX) && f.endsWith(".json"),
  );
  if (files.length === 0) return { pruned: 0, kept: 0 };

  const now = Date.now();
  const infos = await collectFileInfos(port, dir, files, now);

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
      // Prune this file via the port (delete-by-key).
      try {
        const removed = await port.delete(info.key);
        if (removed) {
          pruned++;
        } else {
          kept++; // already gone — count as kept (no-op)
        }
      } catch {
        kept++; // Failed to delete — count as kept
      }
    }
  }

  return { pruned, kept };
}

/** Read each candidate file's mtime + parsed created_at / ttl_hours. */
async function collectFileInfos(
  port: StoragePort,
  dir: string,
  files: string[],
  now: number,
): Promise<FileInfo[]> {
  const infos: FileInfo[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    // FLAG: port doesn't expose mtime — read directly from `fs` for
    // the concurrent-writer guard. Local-fs only today; remote adapters
    // will need StoragePort.stat() before this becomes adapter-agnostic.
    let mtime: number;
    try {
      const stat = await fs.stat(filePath);
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }

    let raw: string | undefined;
    try {
      raw = await port.readText(file);
    } catch {
      continue;
    }
    if (raw === undefined) continue;

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
    infos.push({ key: file, filePath, createdAt, expired, mtime });
  }

  return infos;
}
