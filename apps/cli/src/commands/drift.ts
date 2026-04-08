/**
 * `assignee drift` command — checks managed resources for configuration drift.
 *
 * Shows all managed resources with their drift status in a table.
 * Supports --resource, --region, --status filters, --json output,
 * --output <file>, --concurrency, and progress bar.
 * Exit code 0 = all clean, 1 = drift found.
 *
 * @see Story 28.2, 28.3, 28.5, 28.6
 */

import * as fs from "node:fs/promises";
import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import { DriftStatus, AssigneeError, type DriftResult } from "@assignee/core";
import { ErrorCode } from "../constants/errors.js";
import { MemoryService } from "../services/memory.js";
import { createDriftDetectorFromEnv } from "../services/drift-detector-factory.js";
import { renderDriftDetail } from "../views/drift-detail.js";
import { buildDriftReport } from "../views/drift-report.js";
import { renderProgressBar } from "../views/drift-progress.js";
import { resolveDesiredState } from "../utils/resolve-desired-state.js";

/** Color-coded status label. */
function statusLabel(status: string, noColor = false): string {
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
function renderDriftTable(
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
 * operator state that should be actionable (run `assignee reconcile`
 * or `assignee drift --baseline`), not a failure.
 */
function renderSummary(results: DriftResult[]): void {
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

export const driftCommand = new Command("drift")
  .description("Check managed resources for configuration drift")
  .argument("[resource-id]", "Show detailed drift for a single resource")
  .option("--resource <type>", "Filter by resource type")
  .option("--region <region>", "Filter by AWS region")
  .option("--status <status>", "Filter by drift status")
  .option(
    "--exclude <status>",
    "Exclude a drift status from output (e.g. --exclude BASELINE_MISSING for CI)",
  )
  .option("--json", "Output as JSON")
  .option("--output <file>", "Write JSON report to file (requires --json)")
  .option("--concurrency <n>", "Max parallel drift checks (default 10, max 50)")
  .option("--no-color", "Disable color output")
  .option("--verbose", "Show all fields including matching ones")
  .action(
    async (
      resourceId: string | undefined,
      opts: {
        resource?: string;
        region?: string;
        status?: string;
        exclude?: string;
        json?: boolean;
        output?: string;
        concurrency?: string;
        color?: boolean;
        verbose?: boolean;
      },
    ) => {
      const memory = new MemoryService();
      const rawProvisions = await memory.readProvisions();

      if (rawProvisions.length === 0) {
        process.stdout.write(
          "No managed resources found. Run `assignee plan` and `assignee apply` to provision resources.\n",
        );
        return;
      }

      // A3 follow-up (2026-04-08): dedupe by resourceArn keeping the
      // newest entry per ARN. Past test fixtures accumulate thousands
      // of rows for the same ARN in the provision log — without this
      // pass, `assignee drift` would iterate 6000+ duplicate rows
      // marking each as BASELINE_MISSING (observed on this account
      // during the A3 live probe). Newer `timestamp` wins so the
      // checkpoint resolution path always targets the most recent
      // desiredState.
      const newestByArn = new Map<string, (typeof rawProvisions)[number]>();
      for (const p of rawProvisions) {
        const existing = newestByArn.get(p.resourceArn);
        if (!existing || p.timestamp > existing.timestamp) {
          newestByArn.set(p.resourceArn, p);
        }
      }
      const provisions = Array.from(newestByArn.values());

      // Filter provisions
      let filtered = provisions;
      if (opts.resource) {
        filtered = filtered.filter((p) => p.resourceType === opts.resource);
      }
      if (opts.region) {
        filtered = filtered.filter((p) => p.region === opts.region);
      }

      // Build drift detector from environment credentials (no globalThis DI)
      const detectorResult = createDriftDetectorFromEnv();

      if (!detectorResult) {
        process.stdout.write(
          "Drift detection requires AWS credentials. Configure credentials and try again.\n",
        );
        return;
      }

      const { detector } = detectorResult;

      // Single resource detail view (Story 28.3)
      if (resourceId) {
        const provision = provisions.find(
          (p) =>
            p.resourceArn === resourceId || p.resourceArn.endsWith(resourceId),
        );
        if (!provision) {
          process.stdout.write(
            `Resource '${resourceId}' not found in provision logs.\n`,
          );
          return;
        }

        const desiredState = await resolveDesiredState(provision.resourceArn);
        const driftResult = await detector.checkResource(
          provision.resourceType,
          provision.resourceArn,
          desiredState,
        );

        if (opts.json) {
          process.stdout.write(JSON.stringify(driftResult, null, 2) + "\n");
          return;
        }

        const output = renderDriftDetail(driftResult, {
          noColor: opts.color === false,
          verbose: opts.verbose ?? false,
          lastProvisioned: provision.timestamp,
        });
        process.stdout.write(output + "\n");

        if (driftResult.status === DriftStatus.DRIFTED) {
          process.exitCode = 1;
        }
        return;
      }

      // Parse concurrency option (Story 28.6)
      const concNum = parseInt(opts.concurrency ?? "10", 10);
      if (isNaN(concNum) || concNum < 1) {
        throw new AssigneeError(
          "--concurrency must be a positive integer",
          ErrorCode.USAGE_ERROR,
        );
      }
      const concurrency = Math.min(Math.max(concNum, 1), 50);

      // Batch check all resources with parallelism (Story 28.6)
      const startTime = Date.now();
      const results: DriftResult[] = [];
      let driftedCount = 0;
      const showProgress = !opts.json && process.stderr.isTTY;

      // Use checkAll if available, otherwise sequential with progress
      if (detector.checkAll) {
        const batchResults = await detector.checkAll(
          filtered.map((p) => ({
            typeName: p.resourceType,
            identifier: p.resourceArn,
          })),
          {
            concurrency,
            onProgress: (completed, total, latest) => {
              if (latest.status === DriftStatus.DRIFTED) driftedCount++;
              if (showProgress) {
                renderProgressBar(completed, total, driftedCount);
              }
            },
          },
        );
        results.push(...batchResults);
      } else {
        // Fallback sequential
        let completed = 0;
        for (const provision of filtered) {
          const batchDesiredState = await resolveDesiredState(
            provision.resourceArn,
          );
          const driftResult = await detector.checkResource(
            provision.resourceType,
            provision.resourceArn,
            batchDesiredState,
          );
          results.push(driftResult);
          completed++;
          if (driftResult.status === DriftStatus.DRIFTED) driftedCount++;
          if (showProgress) {
            renderProgressBar(completed, filtered.length, driftedCount);
          }
        }
      }

      if (showProgress) {
        process.stderr.write("\n");
      }

      const checkDurationMs = Date.now() - startTime;

      // Post-filter by status
      let displayResults = results;
      if (opts.status) {
        const statusUpper = opts.status.toUpperCase();
        displayResults = results.filter((r) => r.status === statusUpper);
      }
      // Then --exclude. This runs AFTER --status so the two compose:
      // `--status DRIFTED --exclude ERROR` would yield the intersection,
      // which is the predictable read for operators writing CI gates.
      if (opts.exclude) {
        const excludeUpper = opts.exclude.toUpperCase();
        displayResults = displayResults.filter(
          (r) => r.status !== excludeUpper,
        );
      }

      if (opts.json) {
        const report = buildDriftReport(results, {
          region: opts.region,
          checkDurationMs,
        });
        const jsonOutput = JSON.stringify(report, null, 2) + "\n";

        if (opts.output) {
          await fs.writeFile(opts.output, jsonOutput, "utf-8");
          process.stderr.write(`Report written to ${opts.output}\n`);
        } else {
          process.stdout.write(jsonOutput);
        }
        return;
      }

      const regionMap = new Map(filtered.map((p) => [p.resourceArn, p.region]));
      renderDriftTable(displayResults, regionMap);
      renderSummary(results);

      // Exit code 1 if any drifted
      if (results.some((r) => r.status === DriftStatus.DRIFTED)) {
        process.exitCode = 1;
      }
    },
  );
