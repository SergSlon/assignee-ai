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
import { AssigneeError, serializeErrorEnvelope } from "@assignee/core";
import { AwsErrorName } from "../constants/aws-errors.js";
import { fetchManagedResources } from "../services/list-resources.js";
import {
  renderResourceTable,
  renderEmptyList,
  renderError,
} from "../utils/display.js";
import {
  resolveResourceTypeFilter,
  INVALID_RESOURCE_TYPE_CODE,
} from "./resource-type-filter.js";

/**
 * Epic 92 Wave 2.c (D-30): emit a single JSON error envelope to stdout
 * in addition to the stderr-routed human renderError output. Keeps the
 * text-mode behaviour byte-identical; `--json` consumers now get a
 * parseable envelope regardless of which error class fired.
 */
function writeJsonErrorEnvelope(
  code: string,
  message: string,
  hint?: string,
): void {
  process.stdout.write(serializeErrorEnvelope(code, message, hint));
}

/**
 * Parse an `estimatedMonthlyCost` string into a numeric USD monthly
 * amount. Handles the four shapes the list service emits:
 *
 *   - "$X.XX/mo"                  — take the number as-is
 *   - "$X.XXXX/hr"                — multiply by 730 (AWS billing convention)
 *   - "Free" / "N/A" / "Pay per use" / "Unavailable" — return 0 (skip in sum)
 *   - anything else               — return null so the caller can flag
 *                                   "some rows could not be summed"
 *
 * Exported for unit testing.
 */
export function parseMonthlyCost(raw: string): number | null {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (/^(free|n\/a|pay per use|unavailable)/i.test(trimmed)) return 0;
  const monthlyMatch = trimmed.match(/\$([0-9]+(?:\.[0-9]+)?)(?:\/mo)?$/);
  if (monthlyMatch) {
    const value = Number(monthlyMatch[1]);
    return Number.isFinite(value) ? value : null;
  }
  const hourlyMatch = trimmed.match(/\$([0-9]+(?:\.[0-9]+)?)\/hr$/);
  if (hourlyMatch) {
    const value = Number(hourlyMatch[1]);
    return Number.isFinite(value) ? value * 730 : null;
  }
  return null;
}

export const listCommand = new Command(CommandName.LIST)
  .description(CommandDescription.LIST)
  .option("--json", "Output as JSON array")
  .option("--region <region>", "Filter to a specific AWS region")
  .option(
    "--resource-type <type>",
    "Filter to one CFN resource type (e.g. AWS::S3::Bucket or shorthand S3, Lambda)",
  )
  .option(
    "--total-cost",
    "After the table, print a total estimated monthly cost across all resources (skips Free / N/A / unparseable entries)",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee list
        Table of every assignee-managed resource in the default region
  $ assignee list --region us-east-1
        Only resources in us-east-1
  $ assignee list --resource-type S3
        Only S3 buckets (shorthand accepted; full CFN form also works)
  $ assignee list --resource-type AWS::Lambda::Function
        Only Lambda functions (full CFN form)
  $ assignee list --total-cost
        Include a total-monthly-cost footer
  $ assignee list --json | jq .
        Machine-readable output for scripts

list is read-only — it only reads local provision records + live tags.
No --yes flag is required.
`,
  )
  .action(
    async (opts: {
      json?: boolean;
      region?: string;
      resourceType?: string;
      totalCost?: boolean;
    }) => {
      // Resolve + validate the --resource-type filter BEFORE hitting
      // AWS so invalid input fails fast and surfaces the SSO hint.
      let resolvedResourceType: string | undefined;
      if (opts.resourceType !== undefined) {
        try {
          resolvedResourceType = resolveResourceTypeFilter(opts.resourceType);
        } catch (err) {
          if (
            err instanceof AssigneeError &&
            err.code === INVALID_RESOURCE_TYPE_CODE
          ) {
            renderError(
              `Unknown --resource-type "${opts.resourceType}".`,
              "Pass a supported CFN type (e.g. AWS::S3::Bucket) or a unique shorthand (e.g. S3, Lambda).",
              { why: err.message },
            );
            if (opts.json) {
              // D-30: emit JSON envelope to stdout; registry/help
              // block went to stderr via renderError above.
              writeJsonErrorEnvelope(
                "INVALID_RESOURCE_TYPE",
                `Unknown --resource-type "${opts.resourceType}".`,
                "Pass a supported CFN type (e.g. AWS::S3::Bucket) or a unique shorthand (e.g. S3, Lambda).",
              );
            }
          } else {
            // Story 56-it2-04 P1-01: guard asymmetric error paths.
            // Any non-INVALID_RESOURCE_TYPE_CODE throw from the
            // resolver used to re-throw without a `renderError` call,
            // so Commander dumped a bare stack trace. Route through
            // the same user-friendly surface the happy-path catches
            // use before bubbling the error for the process exit code.
            const message = err instanceof Error ? err.message : String(err);
            renderError(
              `Failed to validate --resource-type "${opts.resourceType}".`,
              "Check the value and try again — see `assignee list --help` for supported types.",
              { why: message },
            );
            if (opts.json) {
              writeJsonErrorEnvelope(
                "RESOURCE_TYPE_RESOLVER_ERROR",
                `Failed to validate --resource-type "${opts.resourceType}".`,
                "Check the value and try again — see `assignee list --help` for supported types.",
              );
            }
          }
          throw err;
        }
      }

      try {
        const resources = await fetchManagedResources(
          opts.region,
          resolvedResourceType,
        );

        if (resources.length === 0) {
          renderEmptyList();
          return;
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(resources, null, 2) + "\n");
          return;
        }

        renderResourceTable(resources);

        if (opts.totalCost) {
          // Sum parseable monthly rates. Unparseable entries are tracked
          // separately so we can warn the operator when the total is
          // incomplete instead of silently under-reporting.
          let total = 0;
          let unparseable = 0;
          for (const r of resources) {
            const parsed = parseMonthlyCost(r.estimatedMonthlyCost);
            if (parsed === null) {
              unparseable++;
            } else {
              total += parsed;
            }
          }
          const totalLine = `Estimated total: $${total.toFixed(2)}/mo`;
          const warn =
            unparseable > 0
              ? ` (${unparseable} resource${unparseable === 1 ? "" : "s"} with non-numeric cost not included)`
              : "";
          process.stdout.write(`\n${totalLine}${warn}\n`);
        }
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        const errName = (error as { name?: string }).name ?? "";

        // Branch shapes preserved so existing test assertions remain
        // valid — JSON envelope is additive (D-30).
        let jsonCode = "LIST_ERROR";
        let jsonMessage = "Failed to list managed resources.";
        let jsonHint: string | undefined;

        if (errName === AwsErrorName.ACCESS_DENIED) {
          renderError(
            "Cannot list managed resources.",
            "Ask your admin to grant the `ResourceGroupsTaggingAPI:GetResources` action.",
            {
              why: "Your IAM identity lacks `tag:GetResources` permission.",
            },
          );
          jsonCode = "ACCESS_DENIED";
          jsonMessage = "Cannot list managed resources.";
          jsonHint =
            "Ask your admin to grant the `ResourceGroupsTaggingAPI:GetResources` action.";
        } else if (
          err.message.includes("ENOTFOUND") ||
          err.message.includes(AwsErrorName.NETWORKING_ERROR) ||
          err.message.includes("getaddrinfo") ||
          errName === AwsErrorName.NETWORKING_ERROR
        ) {
          renderError(
            "Failed to connect to AWS.",
            "Check your internet connection and AWS credentials, then try again.",
          );
          jsonCode = "NETWORK_ERROR";
          jsonMessage = "Failed to connect to AWS.";
          jsonHint =
            "Check your internet connection and AWS credentials, then try again.";
        } else {
          renderError(
            "Failed to list managed resources.",
            "Check your AWS credentials and try again.",
            { why: err.message },
          );
          jsonCode = "LIST_ERROR";
          jsonMessage = "Failed to list managed resources.";
          jsonHint = "Check your AWS credentials and try again.";
        }

        if (opts.json) {
          writeJsonErrorEnvelope(jsonCode, jsonMessage, jsonHint);
        }

        throw new AssigneeError(
          err.message || "Failed to list managed resources.",
          "LIST_ERROR",
        );
      }
    },
  );
