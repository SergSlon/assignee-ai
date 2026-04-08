/**
 * `assignee optimize` — A7 cost-optimization slice (2026-04-08).
 *
 * Scans managed AWS resources, queries the Pricing MCP for the
 * current configuration and a cheaper alternative in parallel, and
 * emits a ranked table of rightsizing recommendations. Read-only:
 * the command never mutates AWS state or any local file.
 *
 * Scope:
 *   - EC2::Instance → Graviton (ARM) swap recommendation
 *   - RDS::DBInstance → Graviton equivalent recommendation
 *   - Other types return "no recommendation" (graceful no-op)
 *
 * Output:
 *   - Human-readable table (default)
 *   - JSON (`--json`) for scripting / CI reports
 *
 * All prices come from the Pricing MCP at runtime — zero hardcoded
 * dollar amounts per `feedback_no_hardcoded_prices.md`.
 *
 * @see apps/cli/src/nodes/advice/cost-optimizer.ts for analyzer
 * @see docs/nfr-assessment-2026-04-08.md — Q-7.2 option ranking
 */

import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import { fetchManagedResources } from "../services/list-resources.js";
import { resolveDesiredState } from "../utils/resolve-desired-state.js";
import {
  analyzeResource,
  type CostOptRecommendation,
} from "../nodes/advice/cost-optimizer.js";
import { runCommand } from "../utils/command-runner.js";
import { LOG_ACTIONS } from "../utils/logger.js";
import { AWS_REGION } from "../config/constants.js";

/**
 * Render the recommendation table to stdout. Non-TTY (CI) output
 * drops the boxen frame for machine-friendly formatting.
 */
function renderTable(
  recommendations: CostOptRecommendation[],
  noColor: boolean,
): void {
  const confLabel = (c: string): string => {
    if (noColor) return c;
    switch (c) {
      case "high":
        return chalk.green(c);
      case "medium":
        return chalk.yellow(c);
      default:
        return chalk.dim(c);
    }
  };

  const headerCells = [
    "Resource ID".padEnd(36),
    "Type".padEnd(22),
    "Current".padEnd(18),
    "Recommended".padEnd(18),
    "Savings".padEnd(18),
    "Confidence".padEnd(10),
  ];
  const header = headerCells.join(" ");
  const divider = "─".repeat(header.length);
  const rows = recommendations.map((r) => {
    // Trim the ARN to its trailing segment for display; the full ARN
    // is still available via `--json`.
    const shortId = (r.resourceArn.split("/").pop() ?? r.resourceArn).slice(
      0,
      35,
    );
    const savingsCell = `${r.monthlySavings} (${r.savingsPercent}%)`;
    return [
      shortId.padEnd(36),
      r.resourceType.padEnd(22),
      r.currentConfig.padEnd(18),
      r.recommendedConfig.padEnd(18),
      savingsCell.padEnd(18),
      confLabel(r.confidence).padEnd(10),
    ].join(" ");
  });

  const content = [chalk.bold(header), chalk.dim(divider), ...rows].join("\n");

  if (process.stdout.isTTY && !noColor) {
    process.stdout.write(
      boxen(content, {
        title: "Cost Optimization Recommendations",
        titleAlignment: "center" as const,
        borderColor: "green",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(content + "\n");
  }
}

/**
 * Render the summary line below the table. Separates "scanned"
 * (resources enumerated via RGTA) from "analyzed" (resources with
 * a checkpoint that could actually be compared) so operators see
 * both the scan coverage and the actionable subset.
 *
 * When no recommendations were found, the message distinguishes
 * three cases:
 *   - 0 analyzable → "N resources scanned, 0 analyzable (no
 *     checkpoint found). Run `assignee plan` or
 *     `assignee drift --baseline <arn>` to adopt."
 *   - ≥1 analyzable, 0 recommendations → "N of M analyzable —
 *     no rightsizing opportunities detected."
 *   - ≥1 recommendation → "N of M analyzable, R recommendations.
 *     Est. total monthly savings: \$X.XX/mo"
 */
function renderSummary(
  totalResourcesScanned: number,
  recommendations: CostOptRecommendation[],
  analyzed: number,
): void {
  if (recommendations.length === 0) {
    if (analyzed === 0) {
      process.stdout.write(
        `\n${totalResourcesScanned} resources scanned, 0 analyzable (no checkpoint found). ` +
          `Run \`assignee plan\` to provision new resources, or \`assignee drift --baseline <arn>\` to adopt existing ones.\n`,
      );
      return;
    }
    process.stdout.write(
      `\n${analyzed} of ${totalResourcesScanned} resources analyzed — no rightsizing opportunities detected.\n`,
    );
    return;
  }

  const totalMonthly = recommendations.reduce(
    (acc, r) => acc + r.savingsAbsoluteUsd,
    0,
  );
  process.stdout.write(
    `\n${analyzed} of ${totalResourcesScanned} resources analyzed, ${recommendations.length} recommendations. ` +
      `Est. total monthly savings: $${totalMonthly.toFixed(2)}/mo\n`,
  );
}

/**
 * Render the reconcile playbook — a list of suggested `assignee plan`
 * commands the operator can copy/paste to apply the top recommendations.
 *
 * This deliberately does NOT auto-execute anything. Graviton swaps
 * require rebuilding the AMI (for EC2) or restoring a snapshot on
 * the new instance class (for RDS), both of which are mutation-heavy
 * interactive flows that should go through the normal `assignee plan`
 * → `assignee apply` pipeline with full HITL review. The --reconcile
 * flag just produces the playbook; the operator is in control.
 */
function renderReconcilePlaybook(
  recommendations: CostOptRecommendation[],
): void {
  if (recommendations.length === 0) return;
  process.stdout.write("\nSuggested reconcile commands (copy/paste):\n");
  for (const r of recommendations) {
    const shortId = r.resourceArn.split("/").pop() ?? r.resourceArn;
    const cmd = `  assignee plan "Change ${r.resourceType} ${shortId} from ${r.currentConfig} to ${r.recommendedConfig}"`;
    process.stdout.write(cmd + "\n");
  }
  process.stdout.write(
    "\nReview each plan carefully before running `assignee apply` — Graviton swaps require AMI rebuild (EC2) or snapshot restore (RDS).\n",
  );
}

export const optimizeCommand = new Command("optimize")
  .description("Scan managed resources for cost-rightsizing opportunities")
  .argument("[resource-id]", "Optional ARN to optimize a single resource")
  .option(
    "--region <region>",
    "AWS region to scan (defaults to AWS_REGION env var)",
  )
  .option("--json", "Emit recommendations as JSON instead of a table")
  .option(
    "--reconcile",
    "Print suggested `assignee plan` commands for each recommendation (operator still runs them manually)",
  )
  .option(
    "--min-savings <usd>",
    "Drop recommendations whose projected monthly savings are below this USD threshold (e.g. 10 for ≥$10/mo)",
  )
  .option("--no-color", "Disable color output")
  .action(
    async (
      resourceId: string | undefined,
      opts: {
        region?: string;
        json?: boolean;
        reconcile?: boolean;
        minSavings?: string;
        color?: boolean;
      },
    ) => {
      const noColor = opts.color === false;
      const asJson = opts.json === true;

      await runCommand({
        intent: "optimize",
        commandName: "optimize",
        startAction: LOG_ACTIONS.PLAN_STARTED,
        endAction: LOG_ACTIONS.PLAN_COMPLETE,
        errorPrefix: "Optimize failed",
        errorHint:
          "Check that AWS credentials are configured and the Pricing MCP server is reachable.",
        silent: asJson,
        run: async (ctx) => {
          const region = opts.region ?? AWS_REGION;
          const allResources = await fetchManagedResources(region);

          // Optional single-resource filter. Matches on the full ARN
          // or on the trailing name segment for operator convenience.
          const targets = resourceId
            ? allResources.filter(
                (r) =>
                  r.arn === resourceId ||
                  r.arn.endsWith(`/${resourceId}`) ||
                  r.arn.endsWith(`:${resourceId}`),
              )
            : allResources;

          // Parse the --min-savings threshold early so an invalid
          // value surfaces as a clear error instead of silently
          // keeping every recommendation.
          let minSavingsUsd = 0;
          if (opts.minSavings !== undefined) {
            const parsed = Number(opts.minSavings);
            if (!Number.isFinite(parsed) || parsed < 0) {
              process.stderr.write(
                `Invalid --min-savings value '${opts.minSavings}': must be a non-negative number\n`,
              );
              return { success: false };
            }
            minSavingsUsd = parsed;
          }

          // For each managed resource, resolve the checkpointed
          // desiredState and delegate to the analyzer. Resources
          // without a checkpoint are silently skipped — optimize
          // cannot make a meaningful recommendation without knowing
          // what the user intended to deploy. Track the two
          // counts separately so the caller can surface "0 of 100
          // scanned were analyzable" vs "0 of 100 had a cheaper
          // alternative" — very different operator experiences.
          const allRecommendations: CostOptRecommendation[] = [];
          let analyzed = 0;
          for (const resource of targets) {
            const desiredState = await resolveDesiredState(resource.arn);
            if (!desiredState) continue;
            analyzed++;
            const recommendation = await analyzeResource(
              { arn: resource.arn, resourceType: resource.resourceType },
              desiredState,
              ctx.tools,
            );
            if (recommendation) allRecommendations.push(recommendation);
          }

          // Drop sub-threshold recommendations when --min-savings is
          // set. The threshold is compared against the absolute USD
          // delta (not percent) so operators can write predictable
          // "only show me recommendations worth ≥$50/month" policies.
          const recommendations = allRecommendations.filter(
            (r) => r.savingsAbsoluteUsd >= minSavingsUsd,
          );

          // Sort highest-saving first so the most impactful
          // recommendation is visible at the top of the table.
          recommendations.sort(
            (a, b) => b.savingsAbsoluteUsd - a.savingsAbsoluteUsd,
          );

          if (asJson) {
            // --reconcile's playbook is additive metadata in JSON
            // mode — emit the same `assignee plan` commands the TTY
            // view prints, so CI pipelines can consume both the
            // machine-readable recommendations and the human-readable
            // action list from a single invocation.
            const reconcilePlaybook = opts.reconcile
              ? recommendations.map((r) => {
                  const shortId =
                    r.resourceArn.split("/").pop() ?? r.resourceArn;
                  return `assignee plan "Change ${r.resourceType} ${shortId} from ${r.currentConfig} to ${r.recommendedConfig}"`;
                })
              : undefined;
            process.stdout.write(
              JSON.stringify(
                {
                  scanned: targets.length,
                  analyzed,
                  skippedMissingCheckpoint: targets.length - analyzed,
                  recommendations,
                  ...(reconcilePlaybook ? { reconcilePlaybook } : {}),
                },
                null,
                2,
              ) + "\n",
            );
          } else {
            if (recommendations.length > 0) {
              renderTable(recommendations, noColor);
            }
            renderSummary(targets.length, recommendations, analyzed);
            if (opts.reconcile) {
              renderReconcilePlaybook(recommendations);
            }
          }

          return { success: true };
        },
      });
    },
  );
