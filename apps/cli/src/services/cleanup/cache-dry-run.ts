/**
 * Dry-run counter for the pricing cache sweep.
 *
 * Mirrors `sweepExpiredPrices` in read-only mode so the orchestrator
 * can preview how many cache files WOULD be removed without mutating.
 *
 * @see Story 33.2
 */

import * as path from "node:path";
import * as os from "node:os";
import { ASSIGNEE_DIR, CLEANUP_MAX_AGE_MS } from "../../config/constants.js";

/**
 * For dry-run mode: count how many cache files would be swept without deleting.
 */
export async function dryRunCacheSweep(
  maxAgeMs: number = CLEANUP_MAX_AGE_MS,
): Promise<{ removed: number; remaining: number }> {
  const cacheDir = path.join(os.homedir(), ASSIGNEE_DIR, "cache", "pricing");
  let entries: string[];
  try {
    const fsSync = await import("node:fs");
    entries = fsSync.readdirSync(cacheDir);
  } catch {
    return { removed: 0, remaining: 0 };
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));
  let removed = 0;
  let remaining = 0;
  const now = Date.now();
  const fsSync = await import("node:fs");

  for (const file of jsonFiles) {
    const filePath = path.join(cacheDir, file);
    let shouldRemove = false;
    try {
      const content = fsSync.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(content) as { cachedAt?: unknown };
      if (typeof entry.cachedAt !== "number" || isNaN(entry.cachedAt)) {
        shouldRemove = true;
      } else if (now - entry.cachedAt > maxAgeMs) {
        shouldRemove = true;
      }
    } catch {
      shouldRemove = true;
    }

    if (shouldRemove) {
      removed++;
    } else {
      remaining++;
    }
  }

  return { removed, remaining };
}
