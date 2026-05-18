/**
 * Terminal formatting for `assignee infra drift`.
 * Wave-6d F4: split out of drift.ts (SRP).
 *
 * Exposes pure rendering helpers — every mutation goes through
 * process.stdout/process.stderr so callers can spy/redirect in tests.
 */
import chalk from "chalk";
import boxen from "boxen";
import { DriftStatus, type DriftResult } from "@assignee/core";

/** Color-coded status label. */
export function statusLabel(status: string, noColor = false): string {
  if (noColor) return status;
  switch (status) {
    case DriftStatus.IN_SYNC:
      return chalk.green(status);
    case DriftStatus.DRIFTED:
      return chalk.red(status);
    case DriftStatus.DELETED:
      return chalk.gray(status);
    case DriftStatus.ERROR:
      return chalk.yellow(status);
    case DriftStatus.BASELINE_MISSING:
      return chalk.yellow(status);
    default:
      return status;
  }
}

/**
 * Render a drift results table.
 */
export function renderDriftTable(
  results: DriftResult[],
  regionMap: Map<string, string>,
): void {
  if (process.stdout.isTTY) {
    const header = chalk.bold(
      `${"Resource Type".padEnd(30)} ${"Resource ID".padEnd(40)} ${"Region".padEnd(15)} ${"Status".padEnd(20)} Drifted`,
    );
    const divider = chalk.dim("─".repeat(header.length));
    const rows = results.map((r) => {
      const region = regionMap.get(r.resourceId) ?? "";
      return `${r.resourceType.padEnd(30)} ${r.resourceId.padEnd(40)} ${region.padEnd(15)} ${statusLabel(r.status).padEnd(20 + 10)} ${r.driftedFields.length}`;
    });
    const content = [header, divider, ...rows].join("\n");
    process.stdout.write(
      boxen(content, {
        title: "Drift Check",
        titleAlignment: "center" as const,
        borderColor: "cyan",
        padding: 1,
      }) + "\n",
    );
  } else {
    const header = `${"Resource Type".padEnd(30)} ${"Resource ID".padEnd(40)} ${"Region".padEnd(15)} ${"Status".padEnd(20)} Drifted`;
    process.stdout.write(header + "\n");
    process.stdout.write("─".repeat(header.length) + "\n");
    for (const r of results) {
      const region = regionMap.get(r.resourceId) ?? "";
      const line = `${r.resourceType.padEnd(30)} ${r.resourceId.padEnd(40)} ${region.padEnd(15)} ${statusLabel(r.status, true).padEnd(20)} ${r.driftedFields.length}`;
      process.stdout.write(line + "\n");
    }
  }
}

/**
 * Render the summary line below the table.
 *
 * A3 (2026-04-08): BASELINE_MISSING is surfaced as its own bucket
 * rather than being collapsed into `errors`. A missing checkpoint
 * is not an error — it means the resource was provisioned outside
 * assignee (or its checkpoint TTL has expired), which is a common
 * operator state that should be actionable (run `assignee infra reconcile`
 * or `assignee infra drift --baseline`), not a failure.
 */
export function renderSummary(results: DriftResult[]): void {
  const total = results.length;
  const inSync = results.filter((r) => r.status === DriftStatus.IN_SYNC).length;
  const drifted = results.filter(
    (r) => r.status === DriftStatus.DRIFTED,
  ).length;
  const deleted = results.filter(
    (r) => r.status === DriftStatus.DELETED,
  ).length;
  const noBaseline = results.filter(
    (r) => r.status === DriftStatus.BASELINE_MISSING,
  ).length;
  const errors = results.filter((r) => r.status === DriftStatus.ERROR).length;

  const parts = [
    `${inSync} in-sync`,
    `${drifted} drifted`,
    `${deleted} deleted`,
  ];
  if (noBaseline > 0) parts.push(`${noBaseline} no-baseline`);
  if (errors > 0) parts.push(`${errors} errors`);

  process.stdout.write(`\n${total} resources checked: ${parts.join(", ")}\n`);
}
