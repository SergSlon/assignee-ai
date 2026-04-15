/**
 * `assignee destroy` command — safely destroys managed AWS resources.
 *
 * Single-resource mode: resolves by ARN or name, confirms, deletes.
 * Bulk mode (--all): plans tier-ordered destruction of all managed resources,
 * requires strict confirmation ("destroy all"), and executes sequentially.
 *
 * Uses CloudControl API DeleteResourceCommand for supported types,
 * SDK fallback for the one remaining CCAPI gap (SNS Subscription; A6 migrated
 * Lambda EventSourceMapping and SNS Topic delete to CCAPI on 2026-04-08).
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
import { BoxenAlign } from "../config/constants.js";
import { Command } from "commander";
import {
  AssigneeError,
  ConfigurationError,
  UserCancelledError,
  CostEstimateLabel,
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
import { AWS_REGION, UserMessage } from "../config/constants.js";
import { ErrorCode } from "../constants/errors.js";
import { destroySingleResource } from "../services/destroy-service.js";
import {
  planBulkDestroy,
  type BulkDestroyPlan,
} from "../services/bulk-destroy.js";

/**
 * Computes the typed-confirmation token for a single-resource destroy.
 *
 * Wave-2 P1-6: returns the resource's own identifier (or the last
 * ARN segment after `/` or `:`) so the user has to re-type the thing
 * they are deleting. Prefers `identifier` when present (CloudControl
 * primary identifier, already human-readable for most types), falling
 * back to `arn.split(/[/:]/).pop()` for edge cases where identifier
 * is empty. Matching is performed case-insensitively by the caller.
 */
export function resourceConfirmationToken(resource: {
  identifier?: string;
  arn: string;
}): string {
  const id = (resource.identifier ?? "").trim();
  if (id) return id;
  const tail = resource.arn.split(/[/:]/).pop() ?? "";
  return tail.trim() || resource.arn;
}

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
        titleAlignment: BoxenAlign.CENTER,
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
      // Item 4b (2026-04-10): explain WHY the confirmation is blocking,
      // so users in CI scripts know this is intentional and not a
      // missing-TTY bug.
      throw new AssigneeError(
        "Bulk destroy irreversibly removes every Assignee-managed resource and needs an explicit confirmation prompt, but stdin is not a TTY. For CI / non-interactive runs, pass `--yes` to acknowledge the blast radius and skip the prompt.",
        ErrorCode.DESTROY_ERROR,
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
      clack.outro(UserMessage.BULK_DESTROY_CANCELLED);
      throw new UserCancelledError(UserMessage.BULK_DESTROY_CANCELLED);
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
        // Item 4b (2026-04-10): IAM is the highest-blast-radius
        // surface in a destroy (self-lockout is possible), so the
        // error spells out exactly why the second prompt exists
        // and what flag bypasses it in CI.
        throw new AssigneeError(
          "Destroying IAM policies and roles can lock Assignee itself out of your account, so `--include-iam` requires a second explicit confirmation, but stdin is not a TTY. For CI / non-interactive runs, pass `--yes` alongside `--include-iam` to acknowledge the extra risk and skip the second prompt.",
          ErrorCode.DESTROY_ERROR,
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
        clack.outro(UserMessage.BULK_DESTROY_CANCELLED);
        throw new UserCancelledError(UserMessage.BULK_DESTROY_CANCELLED);
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
      // Item 4b (2026-04-10): guide-the-user framing with concrete
      // "did you mean?" suggestions for both interpretations.
      throw new AssigneeError(
        `--all destroys everything managed by assignee; a specific resource ("${resource}") is ambiguous. Did you mean "assignee destroy --all" (destroy everything) or "assignee destroy ${resource}" (just that one)?`,
        ErrorCode.USAGE_ERROR,
      );
    }
    return bulkDestroyAction(opts);
  }

  // ── Validate flags that only work with --all ───────────────────────
  if (opts.includeIam) {
    throw new AssigneeError(
      "--include-iam only works in bulk-destroy mode because single-resource destroy already targets one explicit ARN. Usage: `assignee destroy --all --include-iam` to sweep every Assignee-managed resource including IAM policies and roles.",
      ErrorCode.DESTROY_ERROR,
    );
  }
  if (opts.dryRun) {
    throw new AssigneeError(
      "--dry-run only works in bulk-destroy mode; a single-resource destroy has nothing to enumerate. Usage: `assignee destroy --all --dry-run` to preview what would be swept without touching AWS.",
      ErrorCode.DESTROY_ERROR,
    );
  }

  // ── Single-resource mode requires the resource argument ────────────
  if (!resource) {
    throw new AssigneeError(
      "Destroy needs to know what to destroy. Pass a resource ARN or name as the positional argument, e.g. `assignee destroy my-bucket` or `assignee destroy arn:aws:s3:::my-bucket`. To sweep everything Assignee manages at once, use `assignee destroy --all`.",
      ErrorCode.DESTROY_ERROR,
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
      ErrorCode.DESTROY_ERROR,
    );
  }

  // ── Estimate cost savings (Story 19.7) ──────────────────────────────
  const billingTools = await getBillingMcpToolsAsync();
  const savingsEstimate = await getCostSavingsEstimate(
    resolved.arn,
    billingTools,
  );
  const estimatedMonthlyCost =
    savingsEstimate !== CostEstimateLabel.NA
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
        ErrorCode.DESTROY_ERROR,
      );
    }

    // Wave-2 P1-6 (2026-04-14): typed-name confirmation.
    // Bulk destroy already requires typing "destroy all"; single-resource
    // used to accept "yes" which is trivial to muscle-memory into a
    // deletion. Now the user must type the resource's identifier
    // (the short name / last ARN segment) to confirm. This matches the
    // typed-phrase safety bar of `--all` without making it tediously long
    // for a single target.
    const confirmToken = resourceConfirmationToken(resolved);
    const answer = await clack.text({
      message: `Type '${confirmToken}' to confirm destruction, or anything else to cancel:`,
    });

    if (
      clack.isCancel(answer) ||
      typeof answer !== "string" ||
      answer.trim().toLowerCase() !== confirmToken.toLowerCase()
    ) {
      clack.outro(UserMessage.DESTROY_CANCELLED);
      throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
    }
  }

  // ── Delete resource ─────────────────────────────────────────────────
  startSpinner("Destroying resource...");

  const result = await destroySingleResource(resolved, {
    region: resolved.region,
  });

  stopSpinner();

  if (!result.success) {
    // Item 4b (2026-04-10): prefer the provider-level error when
    // present (it's always more specific than a generic "destroy
    // failed"), otherwise guide the user toward the two most useful
    // next actions: confirm the resource still exists and inspect
    // the structured logs.
    throw new AssigneeError(
      result.error ??
        `Destroy call returned no error message — the resource may already be gone or AWS accepted the call without confirming. Run \`assignee list\` to verify, and check \`~/.assignee/logs/\` for the full structured trace.`,
      ErrorCode.DESTROY_ERROR,
    );
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
