/**
 * `assignee clean` command — preview and execute cleanup of stale data.
 *
 * Wave-6d F4: decomposed into `clean/` sub-modules. This file is now a
 * thin Commander wrapper around `cleanAction`.
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
import { cleanAction } from "./clean/orchestrator.js";

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
