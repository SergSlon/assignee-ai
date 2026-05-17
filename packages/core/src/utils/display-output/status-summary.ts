/**
 * Infrastructure status summary renderer (Story 19.6).
 */
import chalk from "chalk";
import boxen from "boxen";
import { BoxenAlign, BoxenBorderColor } from "../../config/constants/ui.js";

/**
 * Minimal shape for infrastructure status summary rendering.
 * Mirrors the production `StatusData` shape emitted by
 * `apps/cli/src/services/status-aggregator` so the renderer can live in
 * @assignee/core without a circular dep back to services.
 *
 * NOTE: the CLI's StatusData re-exports types like `StatusByType`; here we
 * inline the minimal subset the renderer actually reads — the CLI's fuller
 * type is structurally compatible with this narrower one.
 */
export interface StatusData {
  totalResources: number;
  totalEstimatedMonthlyCost: string;
  byType: Array<{ type: string; count: number; estimatedMonthlyCost: string }>;
  byRegion: Array<{
    region: string;
    count: number;
    estimatedMonthlyCost: string;
  }>;
  lastUpdated?: string;
}

export function renderStatusSummary(data: StatusData): void {
  const lines: string[] = [
    `Total Resources: ${data.totalResources}`,
    `Total Est. Monthly Cost: ${data.totalEstimatedMonthlyCost}`,
    "",
    "By Type:",
  ];

  for (const t of data.byType) {
    lines.push(
      `  ${t.type.padEnd(30)} ${String(t.count).padEnd(4)} ${t.estimatedMonthlyCost}`,
    );
  }

  lines.push("");
  lines.push("By Region:");

  for (const r of data.byRegion) {
    lines.push(
      `  ${r.region.padEnd(30)} ${String(r.count).padEnd(4)} ${r.estimatedMonthlyCost}`,
    );
  }

  const content = lines.join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "assignee.ai \u2014 Infrastructure Status",
        titleAlignment: BoxenAlign.CENTER,
        borderColor: BoxenBorderColor.CYAN,
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Infrastructure Status ===\n${content}\n=============================\n`,
    );
  }
}

/**
 * Renders the empty-status message with a hint to run `assignee infra plan`.
 * @see Story 19.6, AC #4
 */
export function renderEmptyStatus(): void {
  const message =
    "No resources managed by assignee.ai. Run `assignee infra plan` to get started.";
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.yellow(message) + "\n");
  } else {
    process.stdout.write(message + "\n");
  }
}
