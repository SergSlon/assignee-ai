/**
 * Cleanup orchestrator — coordinates checkpoint pruning, cache sweep, and memory rotation.
 *
 * Stateless functions that import from the three domain modules and coordinate their
 * cleanup primitives. Both the CLI `clean` command and auto-cleanup hook share this code path.
 *
 * @see Story 33.2
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { pruneExpiredCheckpoints } from "./checkpoint.js";
import { sweepExpiredPrices } from "./price-cache.js";
import type { MemoryService } from "./memory.js";
import {
  ASSIGNEE_DIR,
  AUTO_CLEANUP_INTERVAL_MS,
  CHECKPOINT_FILE_PREFIX,
  CleanupCategoryName,
  CLEANUP_SKIP_RECENT_MINUTES,
  CLEANUP_MAX_AGE_MS,
} from "../config/constants.js";

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
const LAST_CLEANUP_PATH = path.join(
  os.homedir(),
  ASSIGNEE_DIR,
  "cache",
  ".last-cleanup",
);

/** Return a zero-count report (used for skipped categories or missing dirs). */
function emptyReport(): CleanupReport {
  return {
    checkpoints: { pruned: 0, kept: 0 },
    memory: { provisions: 0, failures: 0, patterns: 0 },
    cache: { removed: 0, remaining: 0 },
  };
}

/**
 * For dry-run mode: count how many checkpoint files would be pruned without deleting.
 * Duplicates the logic of pruneExpiredCheckpoints in read-only mode.
 */
async function dryRunCheckpoints(
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

  interface Info {
    createdAt: number;
    expired: boolean;
    mtime: number;
  }
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

/**
 * For dry-run mode: count how many cache files would be swept without deleting.
 */
async function dryRunCacheSweep(
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

/**
 * For dry-run mode: count how many memory records would be trimmed per file.
 */
async function dryRunMemory(
  memoryService: MemoryService,
): Promise<{ provisions: number; failures: number; patterns: number }> {
  const provisions = await memoryService.readProvisions();
  const failures = await memoryService.readFailures();
  const patterns = await memoryService.readPatterns();

  // Import constants to determine caps
  const { MEMORY_MAX_PROVISIONS, MEMORY_MAX_FAILURES, MEMORY_MAX_PATTERNS } =
    await import("../config/constants.js");

  return {
    provisions: Math.max(0, provisions.length - MEMORY_MAX_PROVISIONS),
    failures: Math.max(0, failures.length - MEMORY_MAX_FAILURES),
    patterns: Math.max(0, patterns.length - MEMORY_MAX_PATTERNS),
  };
}

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
  memoryService: MemoryService,
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

/**
 * Format a CleanupReport as a human-readable table.
 *
 * @param report - The cleanup report with counts
 * @param dryRun - Whether this was a preview run
 */
export function formatCleanupReport(
  report: CleanupReport,
  dryRun: boolean,
): string {
  const header = dryRun
    ? "Preview (dry-run) — no changes made:"
    : "Cleanup complete:";

  const lines = [
    header,
    "",
    "Category        Cleaned   Remaining",
    "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    `Checkpoints     ${String(report.checkpoints.pruned).padEnd(10)}${report.checkpoints.kept}`,
    `Price cache     ${String(report.cache.removed).padEnd(10)}${report.cache.remaining}`,
    `Provisions      ${String(report.memory.provisions).padEnd(10)}-`,
    `Failures        ${String(report.memory.failures).padEnd(10)}-`,
    `Patterns        ${String(report.memory.patterns).padEnd(10)}-`,
  ];

  return lines.join("\n");
}
