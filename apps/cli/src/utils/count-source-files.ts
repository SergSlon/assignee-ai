/**
 * Recursively count files in a directory, safely.
 *
 * Hardened against:
 *   - Symlink loops (skips symlinks)
 *   - Excessive depth (hard cap)
 *   - Excessive file count (hard cap)
 *   - Permission errors (skipped with no propagation)
 *
 * Used by `plan.ts` and `apply.ts` to compute `sourceFileCount` for
 * the `--source` flag when uploading files post-provision.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Maximum directory recursion depth before aborting. */
export const COUNT_FILES_MAX_DEPTH = 10;
/** Maximum file count before aborting (prevents DoS on huge trees). */
export const COUNT_FILES_MAX_FILES = 100_000;

export interface CountFilesResult {
  count: number;
  /** True when the cap was hit — count may be an underestimate. */
  truncated: boolean;
}

/**
 * Count files recursively, skipping symlinks to avoid cycles.
 *
 * @param dir - Absolute directory path to walk
 * @returns {count, truncated} where truncated=true means a cap was hit
 */
export function countSourceFiles(dir: string): CountFilesResult {
  let count = 0;
  let truncated = false;

  const walk = (current: string, depth: number): void => {
    if (depth > COUNT_FILES_MAX_DEPTH) {
      truncated = true;
      return;
    }
    if (count >= COUNT_FILES_MAX_FILES) {
      truncated = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // Permission denied, path vanished, etc. — skip
      return;
    }

    for (const entry of entries) {
      if (count >= COUNT_FILES_MAX_FILES) {
        truncated = true;
        return;
      }

      // Skip symlinks entirely — prevents cycles and escape out of the source tree.
      // isSymbolicLink() returns true only for symlinks; isDirectory()/isFile()
      // follow the link, which is what we want to avoid.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), depth + 1);
      } else if (entry.isFile()) {
        count++;
      }
    }
  };

  walk(dir, 0);
  return { count, truncated };
}
