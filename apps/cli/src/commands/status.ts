/**
 * `assignee status` command — shows a summary of managed infrastructure.
 *
 * Queries AWS for resources tagged with `managed-by=assignee-ai` and
 * aggregates them by type and region with cost totals. Supports `--json`
 * for machine-readable output and `--region` to filter by AWS region.
 *
 * This is a direct SDK command (no LangGraph graph), following the same
 * pattern as `assignee list`.
 *
 * @see Story 19.6
 */

import { Command } from "commander";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { ProcessExitCode } from "../constants/errors.js";
import { fetchManagedResources } from "../services/list-resources.js";
import {
  renderStatusSummary,
  renderEmptyStatus,
  renderError,
} from "../utils/display.js";
import { buildStatusData } from "../services/status-aggregator.js";

export const statusCommand = new Command(CommandName.STATUS)
  .description(CommandDescription.STATUS)
  .option("--json", "Output status data as JSON")
  .option("--region <region>", "Filter to a specific AWS region")
  .action(async (opts: { json?: boolean; region?: string }) => {
    try {
      const resources = await fetchManagedResources(opts.region);

      if (resources.length === 0) {
        renderEmptyStatus();
        process.exit(ProcessExitCode.SUCCESS);
        return;
      }

      const statusData = await buildStatusData(resources);

      if (opts.json) {
        process.stdout.write(JSON.stringify(statusData, null, 2) + "\n");
        process.exit(ProcessExitCode.SUCCESS);
        return;
      }

      renderStatusSummary(statusData);
      process.exit(ProcessExitCode.SUCCESS);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      renderError(
        "Failed to fetch status.",
        "Check your AWS credentials and try again.",
        { why: err.message },
      );
      process.exit(ProcessExitCode.GENERIC_ERROR);
    }
  });
