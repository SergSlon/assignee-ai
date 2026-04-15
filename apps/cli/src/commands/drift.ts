/**
 * `assignee drift` command — checks managed resources for configuration drift.
 *
 * Wave-6d F4: decomposed into `drift/` sub-modules. This file is now a
 * thin Commander wrapper. Orchestration + rendering lives under `drift/`.
 *
 * @see Story 28.2, 28.3, 28.5, 28.6
 */

import { Command } from "commander";
import { runBaselineAdopt } from "./drift/baseline-adopt.js";
import { runDrift } from "./drift/orchestrator.js";
import type { DriftOpts } from "./drift/types.js";

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
  .option(
    "--baseline",
    "Adopt the given [resource-id] into drift tracking by snapshotting its live CCAPI state as a baseline",
  )
  .option("--json", "Output as JSON")
  .option("--output <file>", "Write JSON report to file (requires --json)")
  .option("--concurrency <n>", "Max parallel drift checks (default 10, max 50)")
  .option("--no-color", "Disable color output")
  .option("--verbose", "Show all fields including matching ones")
  .option(
    "-y, --yes",
    "Accepted for CI wrapper compatibility; drift is read-only and does not mutate.",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee drift
        Scan all managed resources for configuration drift
  $ assignee drift --resource AWS::S3::Bucket
        Only check S3 buckets
  $ assignee drift --exclude BASELINE_MISSING --json > drift.json
        CI-friendly report without false positives for unadopted resources
  $ assignee drift <arn> --baseline
        Adopt a resource's current state as its drift baseline
  $ assignee drift <arn>
        Detailed diff for a single resource

drift is read-only (it never mutates AWS state except when --baseline is
used, which only writes a local snapshot). No --yes flag is needed — use
\`assignee reconcile --yes\` to auto-apply drift corrections.
`,
  )
  .action(async (resourceId: string | undefined, opts: DriftOpts) => {
    if (opts.baseline) {
      await runBaselineAdopt(resourceId);
      return;
    }
    await runDrift(resourceId, opts);
  });
