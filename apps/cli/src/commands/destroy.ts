/**
 * `assignee destroy` command — safely destroys managed AWS resources.
 *
 * Single-resource mode: resolves by ARN or name, confirms, deletes.
 * Bulk mode (--all): plans tier-ordered destruction of all managed resources,
 * requires strict confirmation ("destroy all"), and executes sequentially.
 *
 * Uses CloudControl API DeleteResourceCommand for supported types,
 * SDK fallback for types with known CCAPI gaps (EventSourceMapping, SNS Subscription).
 *
 * Delegates core deletion logic to destroySingleResource() from destroy-service.ts.
 *
 * @see Story 18.5
 * @see Story 36.1 — Extract reusable destroy logic
 * @see Story 36.3 — Bulk destroy via --all flag
 */

import * as clack from "@clack/prompts";
import chalk from "chalk";
import boxen from "boxen";
import { Command } from "commander";
import {
  AssigneeError,
  ConfigurationError,
  UserCancelledError,
} from "@assignee/core";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { getCostSavingsEstimate } from "../services/billing.js";
import { getBillingMcpToolsAsync } from "../services/mcp-client.js";
import { startSpinner, stopSpinner, updateSpinner } from "../utils/display.js";
import {
  resolveResource,
  createTaggingClient,
} from "../services/resource-resolver.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import { AWS_REGION } from "../config/constants.js";
import { CostEstimate } from "../constants/pricing.js";
import { destroySingleResource } from "../services/destroy-service.js";
import {
  planBulkDestroy,
  type BulkDestroyPlan,
  type ManagedResource,
} from "../services/bulk-destroy.js";

/**
 * Renders a resource details box before confirmation.
 */
function renderDestroyBox(resource: {
  resourceType: string;
  arn: string;
  region: string;
  identifier: string;
  estimatedMonthlyCost: string;
}): void {
  const content = [
    `Resource Type:   ${resource.resourceType}`,
    `ARN:             ${resource.arn}`,
    `Region:          ${resource.region}`,
    `Identifier:      ${resource.identifier}`,
    `Estimated Cost:  ${resource.estimatedMonthlyCost}`,
  ].join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "Destroy Resource",
        titleAlignment: "center",
        borderColor: "red",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Destroy Resource ===\n${content}\n========================\n`,
    );
  }
}

/**
 * Displays success message with estimated savings.
 */
function renderDestroySuccess(estimatedMonthlyCost: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(
      chalk.green(
        `Resource destroyed. Estimated savings: ${estimatedMonthlyCost}\n`,
      ),
    );
  } else {
    process.stdout.write(
      `Resource destroyed. Estimated savings: ${estimatedMonthlyCost}\n`,
    );
  }
}

// ── Bulk destroy helpers ──────────────────────────────────────────────────────

/**
 * Renders the bulk destroy plan as a table.
 */
function renderBulkPlanTable(plan: BulkDestroyPlan): void {
  const resources = plan.resources;
  if (resources.length === 0) {
    process.stdout.write("No resources to destroy.\n");
    return;
  }

  const col = (label: string, values: string[], min: number) =>
    Math.max(min, label.length + 2, ...values.map((v) => v.length + 2));

  const cTier = col(
    "Tier",
    resources.map((r) => String(r.tier)),
    6,
  );
  const cType = col(
    "Type",
    resources.map((r) => r.resourceType),
    25,
  );
  const cArn = col(
    "ARN",
    resources.map((r) => r.arn),
    40,
  );
  const cRegion = col(
    "Region",
    resources.map((r) => r.region),
    12,
  );

  if (process.stdout.isTTY) {
    const header = chalk.bold(
      "Tier".padEnd(cTier) +
        "Type".padEnd(cType) +
        "ARN".padEnd(cArn) +
        "Region".padEnd(cRegion),
    );
    const divider = chalk.dim("─".repeat(cTier + cType + cArn + cRegion));
    const rows = resources.map(
      (r) =>
        chalk.yellow(String(r.tier).padEnd(cTier)) +
        r.resourceType.padEnd(cType) +
        r.arn.padEnd(cArn) +
        r.region.padEnd(cRegion),
    );
    process.stdout.write([header, divider, ...rows, ""].join("\n"));
  } else {
    const header =
      "Tier".padEnd(cTier) +
      "Type".padEnd(cType) +
      "ARN".padEnd(cArn) +
      "Region".padEnd(cRegion);
    const rows = resources.map(
      (r) =>
        String(r.tier).padEnd(cTier) +
        r.resourceType.padEnd(cType) +
        r.arn.padEnd(cArn) +
        r.region.padEnd(cRegion),
    );
    process.stdout.write([header, ...rows, ""].join("\n"));
  }
}

/**
 * Renders the bulk destroy summary line.
 */
function renderBulkSummary(plan: BulkDestroyPlan): void {
  const iamNote = plan.iamCount > 0 ? ` (${plan.iamCount} IAM excluded)` : "";
  const msg = `Will destroy ${plan.resources.length} resources${iamNote}`;

  if (process.stdout.isTTY) {
    process.stdout.write(chalk.red.bold(`\n${msg}\n\n`));
  } else {
    process.stdout.write(`${msg}\n`);
  }
}

/**
 * Renders the post-destruction results summary.
 */
function renderBulkResults(results: {
  destroyed: number;
  failed: number;
}): void {
  const parts = [`${results.destroyed} destroyed`, `${results.failed} failed`];
  const msg = parts.join(", ");

  if (process.stdout.isTTY) {
    process.stdout.write(
      chalk.bold(
        `\n${results.failed > 0 ? chalk.yellow(msg) : chalk.green(msg)}\n`,
      ),
    );
  } else {
    process.stdout.write(`${msg}\n`);
  }
}

/**
 * Handles the --all bulk destroy flow.
 */
async function bulkDestroyAction(opts: {
  yes?: boolean;
  includeIam?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const awsConfig = operatorCredentials();
  const region = awsConfig.region;

  // ── Plan ─────────────────────────────────────────────────────────────
  startSpinner("Planning bulk destruction...");

  const plan = await planBulkDestroy({
    includeIam: opts.includeIam,
    region,
  });

  stopSpinner();

  if (plan.resources.length === 0) {
    process.stdout.write("No managed resources found to destroy.\n");
    return;
  }

  // ── Display plan ───────────────────────────────────────────────────
  renderBulkPlanTable(plan);
  renderBulkSummary(plan);

  // ── Dry run: show plan and exit ────────────────────────────────────
  if (opts.dryRun) {
    process.stdout.write(
      process.stdout.isTTY
        ? chalk.dim("Dry run — no resources were destroyed.\n")
        : "Dry run — no resources were destroyed.\n",
    );
    return;
  }

  // ── Confirmation ───────────────────────────────────────────────────
  if (opts.yes) {
    if (process.stdout.isTTY) {
      process.stderr.write(
        "Warning: --yes flag used in interactive session. Auto-confirming bulk destroy.\n",
      );
    }
  } else {
    if (!process.stdin.isTTY) {
      throw new AssigneeError(
        "Bulk destroy requires confirmation. Use --yes for non-interactive mode.",
        "DESTROY_ERROR",
      );
    }

    const answer = await clack.text({
      message: `Type ${chalk.red('"destroy all"')} to confirm destruction of ${plan.resources.length} resources`,
      validate(value) {
        if (value !== "destroy all") {
          return 'You must type exactly "destroy all" to confirm.';
        }
      },
    });

    if (clack.isCancel(answer)) {
      clack.outro("Bulk destroy cancelled.");
      throw new UserCancelledError("Bulk destroy cancelled.");
    }
  }

  // ── IAM additional confirmation ────────────────────────────────────
  if (opts.includeIam) {
    if (opts.yes) {
      // --yes + --include-iam: flag presence is the confirmation, but warn
      process.stderr.write(
        chalk.yellow(
          "⚠ --yes with --include-iam: IAM policies/roles WILL be destroyed\n",
        ),
      );
    } else {
      if (!process.stdin.isTTY) {
        throw new AssigneeError(
          "IAM destroy requires confirmation. Use --yes for non-interactive mode.",
          "DESTROY_ERROR",
        );
      }

      const iamAnswer = await clack.text({
        message: `IAM resources included. Type ${chalk.red('"include iam"')} to confirm`,
        validate(value) {
          if (value !== "include iam") {
            return 'You must type exactly "include iam" to confirm.';
          }
        },
      });

      if (clack.isCancel(iamAnswer)) {
        clack.outro("Bulk destroy cancelled.");
        throw new UserCancelledError("Bulk destroy cancelled.");
      }
    }
  }

  // ── Execute destruction in tier order ──────────────────────────────
  const total = plan.resources.length;
  let destroyed = 0;
  let failed = 0;

  startSpinner(
    `Destroying 1/${total}: ${plan.resources[0]!.resourceType} ${plan.resources[0]!.arn}`,
  );

  for (let i = 0; i < total; i++) {
    const resource = plan.resources[i]!;
    const progress = `Destroying ${i + 1}/${total}: ${resource.resourceType} ${resource.arn}`;

    updateSpinner(progress);

    try {
      const result = await destroySingleResource(resource, {
        silent: true,
        region: resource.region,
        onProgress: (msg) => updateSpinner(`${i + 1}/${total}: ${msg}`),
      });

      if (result.success) {
        destroyed++;
        if (process.stdout.isTTY) {
          // Log will be visible after spinner stops; for now just count
        }
      } else {
        failed++;
        process.stderr.write(
          `${chalk.red("x")} Failed: ${resource.arn} — ${result.error}\n`,
        );
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${chalk.red("x")} Error: ${resource.arn} — ${message}\n`,
      );
    }
  }

  stopSpinner(`Bulk destroy complete.`);

  // ── Results summary ────────────────────────────────────────────────
  renderBulkResults({ destroyed, failed });
}

/**
 * Core action handler for the destroy command.
 * Exported for testability — the Commander wrapper delegates to this.
 */
export async function destroyAction(
  resource: string | undefined,
  opts: {
    yes?: boolean;
    all?: boolean;
    includeIam?: boolean;
    dryRun?: boolean;
  },
): Promise<void> {
  // ── Bulk destroy mode ──────────────────────────────────────────────
  if (opts.all) {
    if (resource) {
      throw new AssigneeError(
        "Cannot use --all with a specific resource. Use one or the other.",
        "USAGE_ERROR",
      );
    }
    return bulkDestroyAction(opts);
  }

  // ── Validate flags that only work with --all ───────────────────────
  if (opts.includeIam) {
    throw new AssigneeError(
      "--include-iam can only be used with --all.",
      "DESTROY_ERROR",
    );
  }
  if (opts.dryRun) {
    throw new AssigneeError(
      "--dry-run can only be used with --all.",
      "DESTROY_ERROR",
    );
  }

  // ── Single-resource mode requires the resource argument ────────────
  if (!resource) {
    throw new AssigneeError(
      "Resource ARN or name is required. Usage: assignee destroy <resource-arn-or-name>",
      "DESTROY_ERROR",
    );
  }

  // ── Initialize AWS clients ──────────────────────────────────────────
  const awsConfig = operatorCredentials();
  let taggingClient;
  try {
    taggingClient = createTaggingClient(awsConfig);
  } catch {
    throw new ConfigurationError(
      "AWS credentials are not configured. Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables, or run `assignee setup`.",
    );
  }

  // ── Resolve resource ────────────────────────────────────────────────
  startSpinner("Resolving resource...");

  const resolved = await resolveResource(
    resource,
    taggingClient,
    awsConfig.region || AWS_REGION,
  );

  stopSpinner();

  if (!resolved) {
    throw new AssigneeError(
      `No managed resource found matching "${resource}". Run 'assignee list' to see managed resources.`,
      "DESTROY_ERROR",
    );
  }

  // ── Estimate cost savings (Story 19.7) ──────────────────────────────
  const billingTools = await getBillingMcpToolsAsync();
  const savingsEstimate = await getCostSavingsEstimate(
    resolved.arn,
    billingTools,
  );
  const estimatedMonthlyCost =
    savingsEstimate !== CostEstimate.NA
      ? savingsEstimate
      : "(cost data unavailable)";

  // ── Display resource details ────────────────────────────────────────
  renderDestroyBox({
    resourceType: resolved.resourceType,
    arn: resolved.arn,
    region: resolved.region,
    identifier: resolved.identifier,
    estimatedMonthlyCost,
  });

  // ── Confirmation prompt ─────────────────────────────────────────────
  if (opts.yes) {
    // --yes flag: auto-confirm
    if (process.stdout.isTTY) {
      process.stderr.write(
        "Warning: --yes flag used in interactive session. Auto-confirming destroy.\n",
      );
    }
  } else {
    // Non-TTY without --yes is an error
    if (!process.stdin.isTTY) {
      throw new AssigneeError(
        "Destroy requires confirmation. Use --yes for non-interactive mode.",
        "DESTROY_ERROR",
      );
    }

    // Strict confirmation: require "yes"
    const answer = await clack.text({
      message: 'Type "yes" to destroy this resource',
    });

    if (clack.isCancel(answer) || answer !== "yes") {
      clack.outro("Destroy cancelled.");
      throw new UserCancelledError("Destroy cancelled.");
    }
  }

  // ── Delete resource ─────────────────────────────────────────────────
  startSpinner("Destroying resource...");

  const result = await destroySingleResource(resolved, {
    region: resolved.region,
  });

  stopSpinner();

  if (!result.success) {
    throw new AssigneeError(result.error ?? "Destroy failed", "DESTROY_ERROR");
  }

  renderDestroySuccess(estimatedMonthlyCost);
}

export const destroyCommand = new Command(CommandName.DESTROY)
  .description(CommandDescription.DESTROY)
  .argument("[resource]", CommandArgs.RESOURCE.DESC)
  .option(
    "-y, --yes",
    "Auto-confirm destroy without interactive prompt (for CI/CD)",
  )
  .option("--all", "Destroy all managed resources")
  .option(
    "--include-iam",
    "Include IAM policies/roles (excluded by default with --all)",
  )
  .option("--dry-run", "Show what would be destroyed without doing it")
  .action(destroyAction);
