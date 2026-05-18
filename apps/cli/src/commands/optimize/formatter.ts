/**
 * Terminal output for `assignee infra optimize`.
 *
 * Wave-6d F4: split from optimize.ts.
 *
 * - `renderTable`: TTY+color boxen view, or plain (CI) view
 * - `renderSummary`: footer line with three message variants
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
          `Run \`assignee infra plan\` to provision new resources, or \`assignee infra drift --baseline <arn>\` to adopt existing ones.\n`,
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
