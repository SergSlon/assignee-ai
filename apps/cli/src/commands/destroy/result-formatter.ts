/**
 * Rendering helpers for destroy command — boxes, tables, summary lines.
 */

import chalk from "chalk";
import boxen from "boxen";
import { BoxenAlign } from "../../config/constants.js";
import type { BulkDestroyPlan } from "../../services/bulk-destroy.js";

/** Render resource details box before confirmation. */
export function renderDestroyBox(resource: {
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

/** Success message with estimated savings. */
export function renderDestroySuccess(estimatedMonthlyCost: string): void {
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

/** Render the bulk destroy plan as a table. */
export function renderBulkPlanTable(plan: BulkDestroyPlan): void {
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

/** Bulk destroy summary line. */
export function renderBulkSummary(plan: BulkDestroyPlan): void {
  const iamNote = plan.iamCount > 0 ? ` (${plan.iamCount} IAM excluded)` : "";
  const msg = `Will destroy ${plan.resources.length} resources${iamNote}`;

  if (process.stdout.isTTY) {
    process.stdout.write(chalk.red.bold(`\n${msg}\n\n`));
  } else {
    process.stdout.write(`${msg}\n`);
  }
}

/** Post-destruction results summary. */
export function renderBulkResults(results: {
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
