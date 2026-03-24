/**
 * `assignee clean` command — preview and execute cleanup of stale data.
 *
 * Removes expired checkpoints, stale price cache entries, and rotates
 * oversized memory files. Default behaviour is a safe dry-run preview;
 * pass `--confirm` (or `--yes`) to actually mutate.
 *
 * This is a direct SDK command (no LangGraph graph), following the same
 * pattern as `assignee status`.
 *
 * @see Story 33.3
 */

import { Command } from "commander";
import { intro, outro, note } from "@clack/prompts";
import {
  runFullCleanup,
  formatCleanupReport,
  type CleanupCategory,
  type CleanupReport,
} from "../services/cleanup.js";
import { MemoryService } from "../services/memory.js";
import { CHECKPOINT_DIR } from "../config/constants.js";

/** Return true when every numeric value in the report is zero. */
function isEmptyReport(report: CleanupReport): boolean {
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

interface CleanOpts {
  dryRun?: boolean;
  confirm?: boolean;
  yes?: boolean;
  checkpoints?: boolean;
  cache?: boolean;
  memory?: boolean;
  json?: boolean;
}

/** Action handler extracted for reuse by the factory. */
async function cleanAction(opts: CleanOpts): Promise<void> {
  const dryRun = !(opts.confirm || opts.yes);

  // Build categories array from flags; undefined means all
  const categories: CleanupCategory[] = [];
  if (opts.checkpoints) categories.push("checkpoints");
  if (opts.cache) categories.push("cache");
  if (opts.memory) categories.push("memory");
  const catParam = categories.length > 0 ? categories : undefined;

  const memoryService = new MemoryService();

  try {
    const report = await runFullCleanup({
      checkpointDir: CHECKPOINT_DIR,
      memoryService,
      dryRun,
      categories: catParam,
    });

    // JSON output — no human-readable decorations
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }

    // Nothing to clean
    if (isEmptyReport(report)) {
      intro("assignee clean");
      outro("Nothing to clean.");
      return;
    }

    // Human-readable output
    intro("assignee clean");
    const formatted = formatCleanupReport(report, dryRun);
    note(formatted);

    if (dryRun) {
      outro("Run with --confirm to execute.");
    } else {
      outro("Done.");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!opts.json) {
      intro("assignee clean");
      outro(`Cleanup failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Create a fresh clean Command instance.
 * Useful in tests where Commander retains parsed state between runs.
 */
export function createCleanCommand(): Command {
  return new Command("clean")
    .description(
      "Remove stale checkpoints, expired cache, and rotate memory files",
    )
    .option("--dry-run", "Preview cleanup without making changes (default)")
    .option("--confirm", "Execute cleanup (default is dry-run preview)")
    .option("--yes", "Alias for --confirm (CI-friendly)")
    .option("--checkpoints", "Only clean checkpoint files")
    .option("--cache", "Only clean price cache")
    .option("--memory", "Only rotate memory files")
    .option("--json", "Output results as JSON")
    .action(cleanAction);
}

/** Singleton instance for registration in index.ts. */
export const cleanCommand = createCleanCommand();
