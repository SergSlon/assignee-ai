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
import { queryCostAnomalies, type CostAnomaly } from "../services/billing.js";
import { getBillingMcpToolsAsync } from "../services/mcp-client.js";
import {
  computeBPCoverage,
  renderBPCoverage,
  renderBPCoverageGaps,
  filterActionableGaps,
} from "./status-bp-coverage.js";
import { getBpDir } from "./status-factory.js";

export const statusCommand = new Command(CommandName.STATUS)
  .description(CommandDescription.STATUS)
  .option("--json", "Output status data as JSON")
  .option("--region <region>", "Filter to a specific AWS region")
  .option("--bp-coverage", "Show BP rule coverage dashboard")
  .option(
    "--gaps-only",
    "Only meaningful with --bp-coverage. Prints just the list of resource types with zero BP rules and exits non-zero if any gaps are found (CI-friendly). Structural types (RouteTable, VPCGatewayAttachment, etc.) are excluded by default — override with --include-structural-gaps.",
  )
  .option(
    "--include-structural-gaps",
    "Only meaningful with --bp-coverage --gaps-only. Includes structural/cross-reference types (RouteTable, VPCGatewayAttachment, SubnetRouteTableAssociation, EFS::MountTarget) in the gap list. Default is to exclude them because their BP content lives on child resources by design.",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee status
        Summary of managed resources and recent runs
  $ assignee status --json
        Machine-readable status payload
  $ assignee status --bp-coverage
        Best-practice rule coverage dashboard
  $ assignee status --bp-coverage --gaps-only
        CI mode: exit non-zero if any resource type has zero BP rules

status is read-only. No --yes required.
`,
  )
  .action(
    async (opts: {
      json?: boolean;
      region?: string;
      bpCoverage?: boolean;
      gapsOnly?: boolean;
      includeStructuralGaps?: boolean;
    }) => {
      // BP Coverage mode (Story 30.7)
      if (opts.bpCoverage) {
        try {
          // Resolve the best-practices package directory via factory
          const bpDir = getBpDir();

          const data = computeBPCoverage(bpDir);

          // --gaps-only: CI-friendly filtered view. JSON mode returns
          // just the gaps array so `jq length` gives the gap count;
          // text mode prints the short list and exits 1 if non-empty.
          // By default the filter drops structural/cross-reference
          // types whose BP content lives on child resources —
          // opts.includeStructuralGaps restores the raw list for
          // users who explicitly want to audit those too.
          if (opts.gapsOnly) {
            const reportedGaps = opts.includeStructuralGaps
              ? data.gaps
              : filterActionableGaps(data.gaps);
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({ gaps: reportedGaps }, null, 2) + "\n",
              );
            } else {
              renderBPCoverageGaps(reportedGaps);
            }
            if (reportedGaps.length > 0) {
              process.exit(1);
            }
            return;
          }

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

        // Fetch status data and cost anomalies in parallel
        const billingTools = await getBillingMcpToolsAsync();
        const [statusData, anomalies] = await Promise.all([
          buildStatusData(resources),
          billingTools
            ? queryCostAnomalies(billingTools)
            : ([] as CostAnomaly[]),
        ]);

        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                ...statusData,
                ...(anomalies.length > 0 ? { costAnomalies: anomalies } : {}),
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }

        renderStatusSummary(statusData);

        // Render cost anomalies inline (non-blocking enhancement)
        if (anomalies.length > 0) {
          process.stdout.write("\nCost Anomalies:\n");
          for (const a of anomalies) {
            process.stdout.write(
              `  ${a.severity} | ${a.service} | impact: ${a.impact} | ${a.startDate}\n`,
            );
          }
        }
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
