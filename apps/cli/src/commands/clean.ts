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
  json?: boolean;
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
 * AWS resources matching the /e2e|test/i pattern.
 *
 * @returns true if any work was attempted, false if nothing to do
 */
async function cleanResources(opts: CleanOpts): Promise<void> {
  const dryRun = opts.dryRun === true;
  const autoConfirm = opts.confirm || opts.yes;

  // Discover matching resources
  const plan = await planBulkDestroy({ pattern: /e2e|test/i });

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
  const hasLocalFlags = opts.checkpoints || opts.cache || opts.memory;
  const hasResources = opts.resources === true;

  // When --resources is the only flag, skip local cleanup
  const doLocalCleanup = hasLocalFlags || !hasResources;

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

      // JSON output — no human-readable decorations
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        // If --resources is also set, continue; otherwise return
        if (!hasResources) return;
      } else if (isEmptyReport(report)) {
        if (!hasResources) {
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

        if (dryRun && !hasResources) {
          clack.outro("Run with --confirm to execute.");
          return;
        }
      }
    } else {
      // --resources only, no local cleanup
      clack.intro("assignee clean");
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
    .option("--yes", "Alias for --confirm (CI-friendly)")
    .option("--checkpoints", "Only clean checkpoint files")
    .option("--cache", "Only clean price cache")
    .option("--memory", "Only rotate memory files")
    .option("--resources", "Destroy stale e2e/test AWS resources")
    .option("--json", "Output results as JSON")
    .action(cleanAction);
}

/** Singleton instance for registration in index.ts. */
export const cleanCommand = createCleanCommand();
