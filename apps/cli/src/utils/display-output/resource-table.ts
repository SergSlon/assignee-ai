/**
 * Managed-resources table renderer (Story 18.4).
 * TTY mode: chalk-colored headers with padded columns in a boxen frame.
 * Non-TTY mode: tab-separated values with a header row (no ANSI).
 */
import chalk from "chalk";
import boxen from "boxen";
import { CostEstimateLabel } from "@assignee/core";
import { BoxenAlign, BoxenBorderColor } from "../../config/constants.js";
import type { ManagedResource } from "@assignee/core";

/** Shorten an ARN to fit terminal: keep account + resource id. */
function truncateArn(arn: string, maxLen: number): string {
  if (arn.length <= maxLen) return arn;
  const parts = arn.split(":");
  if (parts.length >= 6) {
    const account = parts[4] ?? "";
    const resource = parts.slice(5).join(":");
    const short = `${account}:${resource}`;
    if (short.length <= maxLen) return short;
    return short.slice(0, maxLen - 1) + "…";
  }
  return arn.slice(0, maxLen - 1) + "…";
}

function renderTTYTable(resources: ManagedResource[]): void {
  const col = (label: string, values: string[], min: number) =>
    Math.max(min, label.length + 2, ...values.map((v) => v.length + 2));
  const cType = col(
    "Type",
    resources.map((r) => r.resourceType),
    25,
  );
  const maxArn = 45;
  const cArn = col(
    "Resource",
    resources.map((r) => truncateArn(r.arn, maxArn)),
    30,
  );
  const cRegion = col(
    "Region",
    resources.map((r) => r.region),
    12,
  );
  const cDate = col(
    "Created",
    resources.map((r) =>
      r.createdDate === CostEstimateLabel.NA
        ? CostEstimateLabel.NA
        : r.createdDate.slice(0, 10),
    ),
    10,
  );
  const fmtDate = (d: string) =>
    d === CostEstimateLabel.NA ? CostEstimateLabel.NA : d.slice(0, 10);
  const header = chalk.bold(
    "Type".padEnd(cType) +
      "Resource".padEnd(cArn) +
      "Region".padEnd(cRegion) +
      "Created".padEnd(cDate) +
      "Est. Cost",
  );
  const rows = resources.map(
    (r) =>
      r.resourceType.padEnd(cType) +
      truncateArn(r.arn, maxArn).padEnd(cArn) +
      r.region.padEnd(cRegion) +
      fmtDate(r.createdDate).padEnd(cDate) +
      r.estimatedMonthlyCost,
  );
  const lineWidth = cType + cArn + cRegion + cDate + 20;
  const footer = chalk.dim(
    `\n${resources.length} resource${resources.length === 1 ? "" : "s"} total`,
  );
  const content = [
    header,
    chalk.dim("-".repeat(lineWidth)),
    ...rows,
    footer,
  ].join("\n");

  process.stdout.write(
    boxen(content, {
      title: "Managed Resources",
      titleAlignment: BoxenAlign.CENTER,
      borderColor: BoxenBorderColor.CYAN,
      padding: 1,
    }) + "\n",
  );
}

function renderPlainTable(resources: ManagedResource[]): void {
  const header = "Type\tARN\tRegion\tCreated\tEst. Cost";
  const rows = resources.map(
    (r) =>
      `${r.resourceType}\t${r.arn}\t${r.region}\t${r.createdDate}\t${r.estimatedMonthlyCost}`,
  );
  process.stdout.write([header, ...rows].join("\n") + "\n");
}

export function renderResourceTable(resources: ManagedResource[]): void {
  if (process.stdout.isTTY) {
    renderTTYTable(resources);
  } else {
    renderPlainTable(resources);
  }
}

/**
 * Renders the empty-list message with a hint to run `assignee apply`.
 * @see Story 18.4, AC #5
 */
export function renderEmptyList(): void {
  const message =
    "No resources managed by assignee.ai found. Run `assignee apply` to provision your first resource.";
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.yellow(message) + "\n");
  } else {
    process.stdout.write(message + "\n");
  }
}
