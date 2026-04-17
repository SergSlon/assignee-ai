/**
 * Cleanup orchestrator — coordinates checkpoint pruning, cache sweep, and memory rotation.
 *
 * Stateless functions that import from the three domain modules and
 * coordinate their cleanup primitives. Both the CLI `clean` command and
 * auto-cleanup hook share this code path.
 *
 * Each category runs in its own try/catch so one failure never prevents
 * the others from running.
 *
 * @see Story 33.2
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pruneExpiredCheckpoints } from "@assignee/core/checkpoint";
import { sweepExpiredPrices } from "../price-cache.js";
import type { MemoryService } from "../memory.js";
import {
  AUTO_CLEANUP_INTERVAL_MS,
  CleanupCategoryName,
  CLEANUP_SKIP_RECENT_MINUTES,
} from "../../config/constants.js";
import { dryRunCheckpoints } from "./checkpoint-dry-run.js";
import { dryRunCacheSweep } from "./cache-dry-run.js";
import { dryRunMemory } from "./memory-dry-run.js";
import {
  LAST_CLEANUP_PATH,
  emptyReport,
  type CleanupCategory,
  type CleanupReport,
} from "./types.js";

/**
 * Run a full cleanup across all (or selected) categories.
 *
 * @param opts.checkpointDir - Directory containing checkpoint-*.json files
 * @param opts.memoryService - MemoryService instance for rotation
 * @param opts.dryRun - If true, calculate counts without performing mutations
 * @param opts.categories - Subset of categories to clean; defaults to all three
 */
export async function runFullCleanup(opts: {
  checkpointDir: string;
  memoryService: MemoryService;
  dryRun?: boolean;
  categories?: CleanupCategory[];
}): Promise<CleanupReport> {
  const { checkpointDir, memoryService, dryRun = false } = opts;
  const categories = opts.categories ?? [
    CleanupCategoryName.CHECKPOINTS,
    CleanupCategoryName.CACHE,
    CleanupCategoryName.MEMORY,
  ];

  const report = emptyReport();

  // Run each category independently — one failure should not prevent others
  if (categories.includes(CleanupCategoryName.CHECKPOINTS)) {
    try {
      if (dryRun) {
        report.checkpoints = await dryRunCheckpoints(checkpointDir);
      } else {
        report.checkpoints = await pruneExpiredCheckpoints(checkpointDir);
      }
    } catch {
      // Continue on error — report stays zero
    }
  }

  if (categories.includes(CleanupCategoryName.CACHE)) {
    try {
      if (dryRun) {
        report.cache = await dryRunCacheSweep();
      } else {
        report.cache = sweepExpiredPrices();
      }
    } catch {
      // Continue on error
    }
  }

  if (categories.includes(CleanupCategoryName.MEMORY)) {
    try {
      if (dryRun) {
        report.memory = await dryRunMemory(memoryService);
      } else {
        // Pass preserveFilter to rotateProvisions: never trim records less than 30 days old.
        // This prevents deletion of records for resources still actively managed.
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        const preserveFilter = (record: { timestamp?: string }) => {
          if (!record.timestamp) return false;
          const recordAge = Date.now() - new Date(record.timestamp).getTime();
          return recordAge < THIRTY_DAYS_MS;
        };
        const provisions = await memoryService.rotateProvisions(
          undefined,
          preserveFilter,
        );
        const failures = await memoryService.rotateFailures();
        const patterns = await memoryService.rotatePatterns();
        report.memory = { provisions, failures, patterns };
      }
    } catch {
      // Continue on error
    }
  }

  return report;
}

/**
 * Lightweight auto-cleanup invoked as a side-effect of normal CLI commands.
 * Only runs checkpoint pruning + cache sweep (NOT memory rotation).
 * Throttled to at most once per AUTO_CLEANUP_INTERVAL_MS (1 hour).
 * Swallows all errors — must never affect the parent command.
 */
export async function runAutoCleanup(
  checkpointDir: string,
  _memoryService: MemoryService,
): Promise<void> {
  try {
    // Check throttle
    try {
      const content = await fs.readFile(LAST_CLEANUP_PATH, "utf-8");
      const lastRun = new Date(content.trim());
      if (
        !isNaN(lastRun.getTime()) &&
        Date.now() - lastRun.getTime() < AUTO_CLEANUP_INTERVAL_MS
      ) {
        return; // Throttled — too recent
      }
    } catch {
      // File doesn't exist or is corrupt — treat as "never ran", proceed
    }

    // Run checkpoint pruning with skipRecentMinutes: 10
    await pruneExpiredCheckpoints(checkpointDir, {
      skipRecentMinutes: CLEANUP_SKIP_RECENT_MINUTES,
    });

    // Run cache sweep
    sweepExpiredPrices();

    // Update throttle timestamp
    const cacheDir = path.dirname(LAST_CLEANUP_PATH);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(LAST_CLEANUP_PATH, new Date().toISOString(), "utf-8");
  } catch {
    // Swallow ALL errors — auto-cleanup must never throw
  }
}
