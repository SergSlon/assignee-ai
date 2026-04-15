/**
 * Local (checkpoints + cache + memory) cleanup flow for `assignee clean`.
 *
 * Wave-6d F4: split from clean.ts.
 *
 * Responsibility: pick the category subset (explicit --checkpoints /
 * --cache / --memory, else the full bundle), run runFullCleanup, print
 * the formatted report or "nothing to clean" outro. Log-prune reporting
 * is threaded through so the empty-report short-circuit can take log
 * deletions into account.
 */
import * as clack from "@clack/prompts";
import {
  runFullCleanup,
  formatCleanupReport,
  type CleanupCategory,
  type CleanupReport,
} from "../../services/cleanup.js";
import { MemoryService } from "../../services/memory.js";
import { CHECKPOINT_DIR, CleanupCategoryName } from "../../config/constants.js";
import { runLogPrune } from "./log-prune.js";
import type { CleanOpts } from "./types.js";
import type { PruneResult } from "../../utils/logger.js";

/** Return true when every numeric value in the report is zero. */
export function isEmptyReport(report: CleanupReport): boolean {
  return (
    report.checkpoints.pruned === 0 &&
    report.checkpoints.kept === 0 &&
    report.cache.removed === 0 &&
    report.cache.remaining === 0 &&
    report.memory.provisions === 0 &&
    report.memory.failures === 0 &&
    report.memory.patterns === 0
  );
}

export interface LocalCleanupArgs {
  opts: CleanOpts;
  dryRun: boolean;
  doLogPrune: boolean;
  hasResources: boolean;
}

export interface LocalCleanupOutcome {
  /**
   * `true` when the caller should return early (empty JSON path or
   * "nothing to clean + no resources sweep"). Matches the
   * pre-decomposition short-circuit behavior in clean.ts.
   */
  shouldReturn: boolean;
  pruneResult: (PruneResult & { retentionDays: number; dir: string }) | null;
}

export async function runLocalCleanup(
  args: LocalCleanupArgs,
): Promise<LocalCleanupOutcome> {
  const { opts, dryRun, doLogPrune, hasResources } = args;

  const categories: CleanupCategory[] = [];
  if (opts.checkpoints) categories.push(CleanupCategoryName.CHECKPOINTS);
  if (opts.cache) categories.push(CleanupCategoryName.CACHE);
  if (opts.memory) categories.push(CleanupCategoryName.MEMORY);
  const catParam = categories.length > 0 ? categories : undefined;

  const memoryService = new MemoryService();

  const report = await runFullCleanup({
    checkpointDir: CHECKPOINT_DIR,
    memoryService,
    dryRun,
    categories: catParam,
  });

  // Pre-compute the log prune result so the "nothing to clean" short
  // circuit can take it into account. Running it twice (once here, once
  // for display) would be wasteful and — in non-dry-run mode — would
  // delete the files the second call would try to report on.
  const pruneResult = doLogPrune ? runLogPrune(dryRun) : null;

  // JSON output — no human-readable decorations.
  if (opts.json) {
    const payload = pruneResult ? { ...report, logs: pruneResult } : report;
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    if (!hasResources) return { shouldReturn: true, pruneResult };
    return { shouldReturn: false, pruneResult };
  }

  if (isEmptyReport(report)) {
    const logsEmpty = pruneResult === null || pruneResult.deleted === 0;
    if (!hasResources && logsEmpty) {
      clack.intro("assignee clean");
      clack.outro("Nothing to clean.");
      return { shouldReturn: true, pruneResult };
    }
    clack.intro("assignee clean");
    clack.log.info("Local cleanup: nothing to clean.");
  } else {
    clack.intro("assignee clean");
    const formatted = formatCleanupReport(report, dryRun);
    clack.note(formatted);
  }

  // Log retention prune display (non-JSON).
  if (pruneResult) {
    const verb = dryRun ? "Would delete" : "Deleted";
    clack.log.info(
      `Logs: ${verb} ${pruneResult.deleted} file(s) older than ${pruneResult.retentionDays} day(s); kept ${pruneResult.kept} (${pruneResult.dir})`,
    );
  }

  return { shouldReturn: false, pruneResult };
}
