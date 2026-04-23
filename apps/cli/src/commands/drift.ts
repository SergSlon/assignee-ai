/**
 * `assignee drift` command — checks managed resources for configuration drift.
 *
 * Wave-6d F4: decomposed into `drift/` sub-modules. This file is now a
 * thin Commander wrapper. Orchestration + rendering lives under `drift/`.
 *
 * Epic 92 / story e92-3b2 (D-03, D-04, C-23):
 *   - Removed local `--no-color` and `--verbose` options that shadowed
 *     the global ones declared on the root program in
 *     `apps/cli/src/index.ts`. The global `preSubcommand` hook already
 *     reconciles `--no-color`, `--color`, and `NO_COLOR` into
 *     `chalk.level` for every subcommand, so a local flag is redundant
 *     and produces duplicate entries in `--help` plus precedence bugs.
 *   - Drift's old local `--verbose` meaning ("show all fields, including
 *     matching ones") moved to a new `--detailed` option. The global
 *     `--verbose` now uniformly means "structured diagnostic logs".
 *   - Renamed `--output <file>` → `--output-file <file>` so the flag no
 *     longer collides with other commands' `--output <format>` knob.
 *
 * @see Story 28.2, 28.3, 28.5, 28.6
 */

import { Command } from "commander";
import { runBaselineAdopt } from "./drift/baseline-adopt.js";
import { runDrift } from "./drift/orchestrator.js";
import type { DriftOpts } from "./drift/types.js";
import { installJsonStderrFilter } from "./json-stderr-filter.js";
import { resolveJsonMode } from "./output-format.js";

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
  // Epic 98 e98.W5.N3 (B-07 / D-16): uniform `--json` + `-o, --output
  // <format>` surface across every command. Note: `--output-file <file>`
  // is distinct (kept for backward compat) and writes the JSON report
  // to a file; `-o, --output <format>` enumerates the format (json|text).
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option("--json", "Shorthand for --output json")
  .option("--output-file <file>", "Write JSON report to file (requires --json)")
  .option("--concurrency <n>", "Max parallel drift checks (default 10, max 50)")
  .option("--detailed", "Show all fields including matching ones")
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
  $ assignee drift --json --output-file drift.json
        Write the JSON report to a file instead of stdout
  $ assignee drift <arn> --baseline
        Adopt a resource's current state as its drift baseline
  $ assignee drift <arn> --detailed
        Detailed diff for a single resource, including matching fields

drift is read-only (it never mutates AWS state except when --baseline is
used, which only writes a local snapshot). No --yes flag is needed — use
\`assignee reconcile --yes\` to auto-apply drift corrections.

Use the global \`--no-color\` and \`--verbose\` flags (see Global Options)
to disable ANSI colour or enable structured diagnostic logs.
`,
  )
  .action(async (resourceId: string | undefined, opts: DriftOpts) => {
    // Epic 98 e98.W5.N3: normalise `--json` + `--output json` into one
    // jsonMode boolean, install stderr filter under JSON mode. Opts
    // mutation keeps downstream branches (runDrift reads `opts.json`)
    // byte-identical.
    const jsonMode = resolveJsonMode(opts);
    opts.json = jsonMode || opts.json;
    const stderrFilter = installJsonStderrFilter(jsonMode);
    try {
      if (opts.baseline) {
        await runBaselineAdopt(resourceId);
        return;
      }
      await runDrift(resourceId, opts);
    } finally {
      stderrFilter.restore();
    }
  });
