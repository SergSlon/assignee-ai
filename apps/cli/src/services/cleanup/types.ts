/**
 * Shared types and per-category defaults for the cleanup pipeline.
 *
 * @see Story 33.2
 */

import * as path from "node:path";
import * as os from "node:os";
import { ASSIGNEE_DIR, CleanupCategoryName } from "../../config/constants.js";

/** Per-category counts returned by a cleanup run. */
export interface CleanupReport {
  checkpoints: { pruned: number; kept: number };
  memory: { provisions: number; failures: number; patterns: number };
  cache: { removed: number; remaining: number };
}

/** Subset of cleanup categories that can be individually selected. */
export type CleanupCategory =
  (typeof CleanupCategoryName)[keyof typeof CleanupCategoryName];

/** Path to the throttle file for auto-cleanup. */
export const LAST_CLEANUP_PATH = path.join(
  os.homedir(),
  ASSIGNEE_DIR,
  CleanupCategoryName.CACHE,
  ".last-cleanup",
);

/** Return a zero-count report (used for skipped categories or missing dirs). */
export function emptyReport(): CleanupReport {
  return {
    checkpoints: { pruned: 0, kept: 0 },
    memory: { provisions: 0, failures: 0, patterns: 0 },
    cache: { removed: 0, remaining: 0 },
  };
}
