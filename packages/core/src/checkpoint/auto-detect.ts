/**
 * Checkpoint auto-detect — scans a directory for checkpoint files, filters
 * by TTL / preflight / non-empty desiredState, returns the newest valid one.
 *
 * Used by `assignee infra apply` to resume the most recent plan without the user
 * having to name the runId.
 *
 * Extracted from apps/cli during Wave-6c; promoted to @assignee/core by
 * Story 50-4.
 *
 * RW4d-migration-A (M-016): now accepts an optional `StoragePort` to
 * decouple from `node:fs`. When `storage` is omitted, the function
 * builds a `LocalFsStorageAdapter` rooted at `dir` for backwards
 * compatibility. Keys returned by `list()` are the relative paths
 * under the rootDir — for the checkpoint directory this is just the
 * filename (no nesting), so the existing prefix/suffix filter remains
 * valid.
 */

import {
  PlanCheckpointSchema,
  type PlanCheckpoint,
} from "../schema/checkpoint.js";
import { CHECKPOINT_FILE_PREFIX } from "./constants.js";
import { isCheckpointExpired } from "./ttl.js";
import { LocalFsStorageAdapter } from "../adapters/storage/local-fs-adapter.js";
import type { StoragePort } from "../ports/storage-port.js";

/**
 * Scans a directory for checkpoint files, filters by TTL, returns the newest
 * valid one. Returns null if none are valid or the directory doesn't exist.
 */
export async function findNewestValidCheckpoint(
  dir: string,
  // TODO(SaaS): require StoragePort once all callers thread it through.
  storage?: StoragePort,
): Promise<PlanCheckpoint | null> {
  const port = storage ?? new LocalFsStorageAdapter({ rootDir: dir });

  // `list()` returns sorted keys; missing-rootDir resolves to `[]` so
  // the legacy `(readErr) => null` branch becomes a natural empty-list
  // early-return.
  let entries: string[];
  try {
    entries = await port.list();
  } catch {
    return null;
  }

  const checkpointFiles = entries.filter(
    (f) => f.startsWith(CHECKPOINT_FILE_PREFIX) && f.endsWith(".json"),
  );

  if (checkpointFiles.length === 0) return null;

  let newest: PlanCheckpoint | null = null;
  let newestTime = 0;

  for (const file of checkpointFiles) {
    let raw: string | undefined;
    try {
      raw = await port.readText(file);
    } catch {
      continue;
    }
    if (raw === undefined) continue;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue; // skip corrupt files
    }
    const parsed = PlanCheckpointSchema.safeParse(json);
    if (!parsed.success) continue;

    const cp = parsed.data;
    if (isCheckpointExpired(cp)) continue; // expired
    if (!cp.preflightPassed) continue; // failed preflight
    if (!cp.desiredState || Object.keys(cp.desiredState).length === 0) continue; // empty plan

    const createdMs = new Date(cp.created_at).getTime();
    if (createdMs > newestTime) {
      newest = cp;
      newestTime = createdMs;
    }
  }

  return newest;
}
