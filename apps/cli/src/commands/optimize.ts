/**
 * `assignee optimize` — cost-optimization slice (2026-04-08, A7).
 *
 * Wave-6d F4: decomposed into `optimize/` sub-modules. This file is
 * now a thin Commander wrapper. Read-only: never mutates AWS state or
 * any local file.
 *
 * Epic 92 / story e92-3b2 (D-03): removed the local `--no-color`
 * option that shadowed the global `--no-color` declared on the root
 * program in `apps/cli/src/index.ts`. The global `preSubcommand` hook
 * reconciles the global flag into `chalk.level` before the subcommand
 * runs, so a local redeclaration was both redundant and surfaced as a
 * duplicate entry in `--help`.
 *
 * @see apps/cli/src/nodes/advice/cost-optimizer.ts for analyzer
 * @see docs/nfr-assessment-2026-04-08.md — Q-7.2 option ranking
 */
import { Command } from "commander";
import { DEFAULT_AWS_REGION } from "@assignee/core";
import { runCommand } from "../utils/command-runner.js";
import { LOG_ACTIONS } from "../utils/logger.js";
import { runOptimize } from "./optimize/orchestrator.js";
import type { OptimizeOpts } from "./optimize/types.js";
import { installJsonStderrFilter } from "./json-stderr-filter.js";
import { resolveJsonMode } from "./output-format.js";

export const optimizeCommand = new Command("optimize")
  .description("Scan managed resources for cost-rightsizing opportunities")
  .argument("[resource-id]", "Optional ARN to optimize a single resource")
  .option(
    "--region <region>",
    "AWS region to scan (defaults to AWS_REGION env var)",
  )
  // Epic 98 e98.W5.N3 (B-07 / D-16): uniform `--json` + `-o, --output
  // <format>` across every command.
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option("--json", "Shorthand for --output json")
  .option(
    "--min-savings <usd>",
    "Drop recommendations whose projected monthly savings are below this USD threshold (e.g. 10 for ≥$10/mo)",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee optimize
        Scan all managed resources for rightsizing opportunities
  $ assignee optimize --region ${DEFAULT_AWS_REGION} --min-savings 10
        Only show recommendations projecting ≥$10/mo savings
  $ assignee optimize <arn> --json
        Machine-readable output for a single resource

optimize is read-only — it prints recommendations but never mutates AWS
state. Apply changes via \`assignee plan\` / \`assignee apply\`; no --yes
flag is needed here.

Use the global \`--no-color\` flag (see Global Options) to disable ANSI
colour output.
`,
  )
  .action(async (resourceId: string | undefined, opts: OptimizeOpts) => {
    // Epic 98 e98.W5.N3: normalise `--json` + `--output json` and
    // install the stderr filter under JSON mode. `opts.json` is kept
    // in sync so the downstream `silent: opts.json === true` branch
    // in `runCommand` still gates correctly.
    const jsonMode = resolveJsonMode(opts);
    opts.json = jsonMode || opts.json;
    const stderrFilter = installJsonStderrFilter(jsonMode);
    try {
      await runCommand({
        intent: "optimize",
        commandName: "optimize",
        startAction: LOG_ACTIONS.PLAN_STARTED,
        endAction: LOG_ACTIONS.PLAN_COMPLETE,
        errorPrefix: "Optimize failed",
        errorHint:
          "Check that AWS credentials are configured and the Pricing MCP server is reachable.",
        silent: opts.json === true,
        run: async (ctx) => runOptimize(ctx, { resourceId, opts }),
      });
    } finally {
      stderrFilter.restore();
    }
  });
