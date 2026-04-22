/**
 * Drift orchestrator — wires provision loading → detector resolution →
 * single-resource OR batch-check flow → display / JSON export.
 *
 * Wave-6d F4: split from drift.ts.
 *
 * Epic 92 / story e92-3b2 (C-23): reads `opts.outputFile` (renamed from
 * `opts.output` — see types.ts).
 */
import * as fs from "node:fs/promises";
import { DriftStatus, type DriftResult } from "@assignee/core";
import { MemoryService } from "../../services/memory.js";
import { createDriftDetectorFromEnv } from "../../services/drift-detector-factory.js";
import { buildDriftReport } from "../../views/drift-report.js";
import { renderDriftTable, renderSummary } from "./report-formatter.js";
import { runSingleResourceDetail } from "./single-resource.js";
import { parseConcurrency, runBatchDriftCheck } from "./live-progress.js";
import type { DriftOpts } from "./types.js";

export async function runDrift(
  resourceId: string | undefined,
  opts: DriftOpts,
): Promise<void> {
  const memory = new MemoryService();
  const rawProvisions = await memory.readProvisions();

  if (rawProvisions.length === 0) {
    process.stdout.write(
      "No managed resources found. Run `assignee plan` and `assignee apply` to provision resources.\n",
    );
    return;
  }

  // A3 follow-up (2026-04-08): dedupe by resourceArn keeping the newest
  // entry per ARN so old provision-log duplicates do not balloon the
  // scan. Newer `timestamp` wins.
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

  // Build drift detector from environment credentials via factory.
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
    await runSingleResourceDetail({
      resourceId,
      provisions,
      detector,
      opts,
    });
    return;
  }

  const concurrency = parseConcurrency(opts.concurrency);
  const showProgress = !opts.json && process.stderr.isTTY;

  const { results, checkDurationMs } = await runBatchDriftCheck({
    filtered,
    detector,
    concurrency,
    showProgress,
  });

  if (showProgress) {
    process.stderr.write("\n");
  }

  // Post-filter by status; then --exclude (composes as intersection so
  // `--status DRIFTED --exclude ERROR` is predictable for CI gates).
  let displayResults: DriftResult[] = results;
  if (opts.status) {
    const statusUpper = opts.status.toUpperCase();
    displayResults = results.filter((r) => r.status === statusUpper);
  }
  if (opts.exclude) {
    const excludeUpper = opts.exclude.toUpperCase();
    displayResults = displayResults.filter((r) => r.status !== excludeUpper);
  }

  if (opts.json) {
    const report = buildDriftReport(results, {
      region: opts.region,
      checkDurationMs,
    });
    const jsonOutput = JSON.stringify(report, null, 2) + "\n";

    if (opts.outputFile) {
      await fs.writeFile(opts.outputFile, jsonOutput, "utf-8");
      process.stderr.write(`Report written to ${opts.outputFile}\n`);
    } else {
      process.stdout.write(jsonOutput);
    }
    return;
  }

  const regionMap = new Map(filtered.map((p) => [p.resourceArn, p.region]));
  renderDriftTable(displayResults, regionMap);
  renderSummary(results);

  if (results.some((r) => r.status === DriftStatus.DRIFTED)) {
    process.exitCode = 1;
  }
}
