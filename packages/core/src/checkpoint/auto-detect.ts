/**
 * Checkpoint auto-detect — scans a directory for checkpoint files, filters
 * by TTL / preflight / non-empty desiredState, returns the newest valid one.
 *
 * Used by `assignee apply` to resume the most recent plan without the user
 * having to name the runId.
 *
 * Extracted from apps/cli during Wave-6c; promoted to @assignee/core by
 * Story 50-4.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  PlanCheckpointSchema,
  type PlanCheckpoint,
} from "../schema/checkpoint.js";
import { safeTry } from "../types/result.js";
import { CHECKPOINT_FILE_PREFIX } from "./constants.js";
import { isCheckpointExpired } from "./ttl.js";

/**
 * Scans a directory for checkpoint files, filters by TTL, returns the newest
 * valid one. Returns null if none are valid or the directory doesn't exist.
 */
export async function findNewestValidCheckpoint(
  dir: string,
): Promise<PlanCheckpoint | null> {
  const [readErr, entries] = await safeTry(fs.readdir(dir));
  if (readErr) return null;

  const checkpointFiles = entries.filter(
    (f) => f.startsWith(CHECKPOINT_FILE_PREFIX) && f.endsWith(".json"),
  );

  if (checkpointFiles.length === 0) return null;

  let newest: PlanCheckpoint | null = null;
  let newestTime = 0;

  for (const file of checkpointFiles) {
    const [err, raw] = await safeTry(
      fs.readFile(path.join(dir, file), "utf-8"),
    );
    if (err) continue;

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
