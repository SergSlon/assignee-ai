/**
 * `assignee list` command — lists all resources managed by assignee.ai.
 *
 * Queries AWS Resource Groups Tagging API for resources tagged with
 * `managed-by=assignee-ai`. Supports `--json` for machine-readable output
 * and `--region` to filter by AWS region.
 *
 * This is a direct SDK command (no LangGraph graph), following the same
 * pattern as `assignee init`.
 *
 * @see Story 18.4, FR-40
 */

import { Command } from "commander";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { ProcessExitCode } from "../constants/errors.js";
import { fetchManagedResources } from "../services/list-resources.js";
import {
  renderResourceTable,
  renderEmptyList,
  renderError,
} from "../utils/display.js";

export const listCommand = new Command(CommandName.LIST)
  .description(CommandDescription.LIST)
  .option("--json", "Output as JSON array")
  .option("--region <region>", "Filter to a specific AWS region")
  .action(async (opts: { json?: boolean; region?: string }) => {
    try {
      const resources = await fetchManagedResources(opts.region);

      if (resources.length === 0) {
        renderEmptyList();
        process.exit(ProcessExitCode.SUCCESS);
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(resources, null, 2) + "\n");
        process.exit(ProcessExitCode.SUCCESS);
        return;
      }

      renderResourceTable(resources);
      process.exit(ProcessExitCode.SUCCESS);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const errName = (error as { name?: string }).name ?? "";

      if (errName === "AccessDeniedException") {
        renderError(
          "Cannot list managed resources.",
          "Ask your admin to grant the `ResourceGroupsTaggingAPI:GetResources` action.",
          {
            why: "Your IAM identity lacks `tag:GetResources` permission.",
          },
        );
      } else if (
        err.message.includes("ENOTFOUND") ||
        err.message.includes("NetworkingError") ||
        err.message.includes("getaddrinfo") ||
        errName === "NetworkingError"
      ) {
        renderError(
          "Failed to connect to AWS.",
          "Check your internet connection and AWS credentials, then try again.",
        );
      } else {
        renderError(
          "Failed to list managed resources.",
          "Check your AWS credentials and try again.",
          { why: err.message },
        );
      }

      process.exit(ProcessExitCode.GENERIC_ERROR);
    }
  });
