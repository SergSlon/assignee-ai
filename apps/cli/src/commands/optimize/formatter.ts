/**
 * Terminal output for `assignee optimize`.
 *
 * Wave-6d F4: split from optimize.ts.
 *
 * - `renderTable`: TTY+color boxen view, or plain (CI) view
 * - `renderSummary`: footer line with three message variants
 * - `renderReconcilePlaybook`: copy/paste `assignee plan` commands
 */
import chalk from "chalk";
import boxen from "boxen";
import type { CostOptRecommendation } from "../../nodes/advice/cost-optimizer/types.js";

/**
 * Render the recommendation table to stdout. Non-TTY output drops the
 * boxen frame for machine-friendly formatting.
 */
export function renderTable(
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
    // Trim ARN to trailing segment for display; full ARN remains in --json.
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
 * Render the summary line below the table. Three message variants:
 *   - 0 analyzable → "N resources scanned, 0 analyzable (no checkpoint found)…"
 *   - ≥1 analyzable, 0 recommendations → "N of M analyzable — no rightsizing opportunities…"
 *   - ≥1 recommendation → "N of M analyzable, R recommendations. Est. total monthly savings: $X.XX/mo"
 */
export function renderSummary(
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
 * Deliberately does NOT auto-execute anything. Graviton swaps require
 * rebuilding the AMI (EC2) or restoring a snapshot on the new instance
 * class (RDS), both of which are mutation-heavy interactive flows that
 * go through the normal `assignee plan` → `assignee apply` pipeline.
 */
export function renderReconcilePlaybook(
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

export function buildReconcilePlaybookLines(
  recommendations: CostOptRecommendation[],
): string[] {
  return recommendations.map((r) => {
    const shortId = r.resourceArn.split("/").pop() ?? r.resourceArn;
    return `assignee plan "Change ${r.resourceType} ${shortId} from ${r.currentConfig} to ${r.recommendedConfig}"`;
  });
}
