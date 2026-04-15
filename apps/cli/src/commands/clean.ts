/**
 * `assignee clean` command — preview and execute cleanup of stale data.
 *
 * Removes expired checkpoints, stale price cache entries, and rotates
 * oversized memory files. Default behaviour is a safe dry-run preview;
 * pass `--confirm` (or `--yes`) to actually mutate.
 *
 * The `--resources` flag extends clean to destroy stale e2e/test AWS
 * resources tagged with `managed-by=assignee-ai`.
 *
 * This is a direct SDK command (no LangGraph graph), following the same
 * pattern as `assignee status`.
 *
 * @see Story 33.3
 * @see Story 36.4 — --resources flag for AWS resource cleanup
 */

import { Command } from "commander";
import * as clack from "@clack/prompts";
import { AssigneeError } from "@assignee/core";
import { ErrorCode } from "../constants/errors.js";
import {
  runFullCleanup,
  formatCleanupReport,
  type CleanupCategory,
  type CleanupReport,
} from "../services/cleanup.js";
import { MemoryService } from "../services/memory.js";
import {
  CHECKPOINT_DIR,
  CleanupCategoryName,
  UserMessage,
} from "../config/constants.js";
import {
  planBulkDestroy,
  type ManagedResource,
} from "../services/bulk-destroy.js";
import { destroySingleResource } from "../services/destroy-service.js";
import {
  pruneOldLogs,
  resolveLogRetentionDays,
  getLogDir,
  type PruneResult,
} from "../utils/logger.js";

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
  resources?: boolean;
  logs?: boolean;
  baselines?: boolean;
  json?: boolean;
}

/**
 * Prune old persistent log files under `~/.assignee/logs` (or
 * `ASSIGNEE_LOG_DIR`). Honors `ASSIGNEE_LOG_RETENTION_DAYS` (default 14).
 *
 * In dry-run mode this reports counts without deleting. Because
 * `pruneOldLogs` is destructive by design, dry-run is implemented by
 * re-implementing the walk here without the `unlink` call — keeping the
 * production path single-responsibility.
 */
function runLogPrune(
  dryRun: boolean,
): PruneResult & { retentionDays: number; dir: string } {
  const retentionDays = resolveLogRetentionDays();
  const dir = getLogDir();
  const result = pruneOldLogs(dir, retentionDays, new Date(), { dryRun });
  return { ...result, retentionDays, dir };
}

/**
 * Formats a table of managed resources for display.
 */
function formatResourceTable(resources: ManagedResource[]): string {
  const lines: string[] = [];
  const typeWidth = Math.max(
    ...resources.map((r) => r.resourceType.length),
    "Type".length,
  );
  const idWidth = Math.max(
    ...resources.map((r) => r.identifier.length),
    "Identifier".length,
  );

  lines.push(
    `${"Type".padEnd(typeWidth)}  ${"Identifier".padEnd(idWidth)}  Region`,
  );
  lines.push(
    `${"─".repeat(typeWidth)}  ${"─".repeat(idWidth)}  ${"─".repeat(12)}`,
  );

  for (const r of resources) {
    lines.push(
      `${r.resourceType.padEnd(typeWidth)}  ${r.identifier.padEnd(idWidth)}  ${r.region}`,
    );
  }
  return lines.join("\n");
}

/**
 * Handles the --resources flag: discovers and destroys stale e2e/test
 * AWS resources matching a strict prefix pattern.
 *
 * Prior version used `/e2e|test/i` which matched any production resource
 * whose name contained "test" (e.g., `my-test-logs`, `test-invoice-reports`).
 * New pattern requires an explicit `e2e-test/` path prefix, `e2e-`/`assignee-e2e-`
 * name prefix, or the `poc-apply-test-` legacy pattern.
 *
 * @returns true if any work was attempted, false if nothing to do
 */
async function cleanResources(opts: CleanOpts): Promise<void> {
  const dryRun = opts.dryRun === true;
  const autoConfirm = opts.confirm || opts.yes;

  // Discover matching resources — strict prefixes only, anchored
  const plan = await planBulkDestroy({
    pattern: /(?:^|\/|:)(e2e-test\/|e2e-|assignee-e2e-|poc-apply-test-)/i,
  });

  if (plan.resources.length === 0) {
    clack.log.info("No stale test resources found.");
    return;
  }

  // Display matching resources as a table
  const table = formatResourceTable(plan.resources);
  clack.note(table, `${plan.resources.length} test/e2e resources found`);

  // Dry-run: show table and exit
  if (dryRun) {
    clack.log.info(
      "Dry run — no resources destroyed. Run with --confirm to execute.",
    );
    return;
  }

  // Confirmation gate
  if (autoConfirm) {
    // auto-confirm via --yes / --confirm
  } else if (process.stdin.isTTY) {
    const answer = await clack.text({
      message: `Type "clean" to destroy ${plan.resources.length} resources`,
    });
    if (clack.isCancel(answer) || answer !== "clean") {
      clack.log.warn(UserMessage.RESOURCE_CLEANUP_CANCELLED);
      return;
    }
  } else {
    // Non-TTY without --yes is an error
    throw new AssigneeError(
      "Resource cleanup requires confirmation. Use --yes for non-interactive mode.",
      ErrorCode.USAGE_ERROR,
    );
  }

  // Execute destruction with progress spinner
  const spinner = clack.spinner();
  const total = plan.resources.length;
  let succeeded = 0;
  let failed = 0;

  spinner.start(
    `Cleaning 1/${total}: ${plan.resources[0]!.resourceType} ${plan.resources[0]!.identifier}`,
  );

  for (let i = 0; i < total; i++) {
    const resource = plan.resources[i]!;
    spinner.message(
      `Cleaning ${i + 1}/${total}: ${resource.resourceType} ${resource.identifier}`,
    );

    const result = await destroySingleResource(resource, {
      region: resource.region,
      silent: true,
    });

    if (result.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  spinner.stop(`Cleaned ${succeeded} resources, ${failed} failed`);
}

/** Action handler extracted for reuse by the factory. */
async function cleanAction(opts: CleanOpts): Promise<void> {
  const dryRun = !(opts.confirm || opts.yes);

  // ── --baselines: standalone scope (A3 follow-up) ─────────────────
  // Runs independently of the main cleanup machinery because adopted
  // baselines are a new storage root not yet represented in
  // CleanupCategoryName / runFullCleanup. Threading them through the
  // full report pipeline would touch 6+ files for a single directory
  // delete; a scoped self-contained block is the minimum-viable
  // cleanup surface.
  if (opts.baselines === true) {
    const { BASELINES_DIR } = await import("../config/constants.js");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const baselineDir = path.resolve(process.cwd(), BASELINES_DIR);
    let files: string[] = [];
    try {
      files = await fs.readdir(baselineDir);
    } catch {
      process.stdout.write("No baseline files found (nothing to clean).\n");
      return;
    }
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    if (jsonFiles.length === 0) {
      process.stdout.write("No baseline files found (nothing to clean).\n");
      return;
    }
    if (dryRun) {
      process.stdout.write(
        `Would remove ${jsonFiles.length} baseline file${jsonFiles.length === 1 ? "" : "s"} from ${baselineDir}:\n`,
      );
      for (const f of jsonFiles) process.stdout.write(`  ${f}\n`);
      process.stdout.write("\nRe-run with --confirm to delete.\n");
      return;
    }
    for (const f of jsonFiles) {
      await fs.unlink(path.join(baselineDir, f)).catch(() => {});
    }
    process.stdout.write(
      `Removed ${jsonFiles.length} baseline file${jsonFiles.length === 1 ? "" : "s"} from ${baselineDir}.\n`,
    );
    return;
  }

  const hasLocalFlags = opts.checkpoints || opts.cache || opts.memory;
  const hasResources = opts.resources === true;
  const hasLogs = opts.logs === true;
  const hasAnyScopedFlag = hasLocalFlags || hasResources || hasLogs;

  // Local (checkpoints/cache/memory) cleanup runs when:
  //  - explicit local flags are set, OR
  //  - no scoped flag is set at all (default "everything" behaviour)
  const doLocalCleanup = hasLocalFlags || !hasAnyScopedFlag;
  // Log pruning runs when --logs is explicit OR no scoped flag at all.
  const doLogPrune = hasLogs || !hasAnyScopedFlag;

  try {
    // ── Local cleanup (checkpoints, cache, memory) ────────────────────
    if (doLocalCleanup) {
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

      // JSON output — no human-readable decorations
      if (opts.json) {
        const payload = pruneResult ? { ...report, logs: pruneResult } : report;
        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
        // If --resources is also set, continue; otherwise return
        if (!hasResources) return;
      } else if (isEmptyReport(report)) {
        const logsEmpty = pruneResult === null || pruneResult.deleted === 0;
        if (!hasResources && logsEmpty) {
          clack.intro("assignee clean");
          clack.outro("Nothing to clean.");
          return;
        }
        clack.intro("assignee clean");
        clack.log.info("Local cleanup: nothing to clean.");
      } else {
        clack.intro("assignee clean");
        const formatted = formatCleanupReport(report, dryRun);
        clack.note(formatted);
      }

      // ── Log retention prune display (non-JSON) ─────────────────────
      if (pruneResult && !opts.json) {
        const verb = dryRun ? "Would delete" : "Deleted";
        clack.log.info(
          `Logs: ${verb} ${pruneResult.deleted} file(s) older than ${pruneResult.retentionDays} day(s); kept ${pruneResult.kept} (${pruneResult.dir})`,
        );
      }
    } else {
      // --resources / --logs only, no local cleanup
      clack.intro("assignee clean");

      if (doLogPrune) {
        const pruneResult = runLogPrune(dryRun);
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ logs: pruneResult }, null, 2) + "\n",
          );
        } else {
          const verb = dryRun ? "Would delete" : "Deleted";
          clack.log.info(
            `Logs: ${verb} ${pruneResult.deleted} file(s) older than ${pruneResult.retentionDays} day(s); kept ${pruneResult.kept} (${pruneResult.dir})`,
          );
        }
      }
    }

    // ── AWS resource cleanup ──────────────────────────────────────────
    if (hasResources) {
      await cleanResources({ ...opts, dryRun });
    }

    if (!opts.json) {
      if (dryRun) {
        clack.outro("Run with --confirm to execute.");
      } else {
        clack.outro("Done.");
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!opts.json) {
      clack.intro("assignee clean");
      clack.outro(`Cleanup failed: ${message}`);
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
      "Remove stale checkpoints, expired cache, rotate memory files, and destroy test AWS resources",
    )
    .option("--dry-run", "Preview cleanup without making changes (default)")
    .option("--confirm", "Execute cleanup (default is dry-run preview)")
    .option("-y, --yes", "Alias for --confirm (CI-friendly, canonical)")
    .option("--checkpoints", "Only clean checkpoint files")
    .option("--cache", "Only clean price cache")
    .option("--memory", "Only rotate memory files")
    .option("--resources", "Destroy stale e2e/test AWS resources")
    .option(
      "--logs",
      "Prune persistent warn/error log files older than the retention window (ASSIGNEE_LOG_RETENTION_DAYS, default 14 days)",
    )
    .option(
      "--baselines",
      "Remove all baseline files adopted via `assignee drift --baseline`",
    )
    .option("--json", "Output results as JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ assignee clean                      Preview cleanup actions (dry-run)
  $ assignee clean --yes                Execute full cleanup in CI (canonical flag)
  $ assignee clean --confirm --cache    Delete only the price cache
  $ assignee clean --yes --checkpoints  Delete expired plan checkpoints
  $ assignee clean --yes --resources    Destroy tagged e2e/test AWS resources
`,
    )
    .action(cleanAction);
}

/** Singleton instance for registration in index.ts. */
export const cleanCommand = createCleanCommand();
