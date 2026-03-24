/**
 * `assignee status` command — shows a summary of managed infrastructure.
 *
 * Queries AWS for resources tagged with `managed-by=assignee-ai` and
 * aggregates them by type and region with cost totals. Supports `--json`
 * for machine-readable output and `--region` to filter by AWS region.
 *
 * Also supports `--bp-coverage` for BP coverage dashboard.
 *
 * This is a direct SDK command (no LangGraph graph), following the same
 * pattern as `assignee list`.
 *
 * @see Story 19.6, Story 30.7
 */

import * as path from "node:path";
import { Command } from "commander";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { AssigneeError } from "@assignee/core";
import { fetchManagedResources } from "../services/list-resources.js";
import {
  renderStatusSummary,
  renderEmptyStatus,
  renderError,
} from "../utils/display.js";
import { buildStatusData } from "../services/status-aggregator.js";
import { computeBPCoverage, renderBPCoverage } from "./status-bp-coverage.js";

export const statusCommand = new Command(CommandName.STATUS)
  .description(CommandDescription.STATUS)
  .option("--json", "Output status data as JSON")
  .option("--region <region>", "Filter to a specific AWS region")
  .option("--bp-coverage", "Show BP rule coverage dashboard")
  .action(
    async (opts: { json?: boolean; region?: string; bpCoverage?: boolean }) => {
      // BP Coverage mode (Story 30.7)
      if (opts.bpCoverage) {
        try {
          // Resolve the best-practices package directory
          const bpDir =
            ((globalThis as Record<string, unknown>)["__bpDir"] as string) ??
            path.resolve(
              import.meta.dirname,
              "../../../../packages/best-practices",
            );

          const data = computeBPCoverage(bpDir);

          if (opts.json) {
            process.stdout.write(JSON.stringify(data, null, 2) + "\n");
            return;
          }

          renderBPCoverage(data);
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          renderError(
            "Failed to compute BP coverage.",
            "Ensure packages/best-practices/ directory is accessible.",
            { why: err.message },
          );
        }
        return;
      }

      try {
        const resources = await fetchManagedResources(opts.region);

        if (resources.length === 0) {
          renderEmptyStatus();
          return;
        }

        const statusData = await buildStatusData(resources);

        if (opts.json) {
          process.stdout.write(JSON.stringify(statusData, null, 2) + "\n");
          return;
        }

        renderStatusSummary(statusData);
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        renderError(
          "Failed to fetch status.",
          "Check your AWS credentials and try again.",
          { why: err.message },
        );
        throw new AssigneeError(
          err.message || "Failed to fetch status.",
          "STATUS_ERROR",
        );
      }
    },
  );
