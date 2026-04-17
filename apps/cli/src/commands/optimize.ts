/**
 * `assignee optimize` — cost-optimization slice (2026-04-08, A7).
 *
 * Wave-6d F4: decomposed into `optimize/` sub-modules. This file is
 * now a thin Commander wrapper. Read-only: never mutates AWS state or
 * any local file.
 *
 * @see apps/cli/src/nodes/advice/cost-optimizer.ts for analyzer
 * @see docs/nfr-assessment-2026-04-08.md — Q-7.2 option ranking
 */
import { Command } from "commander";
import { runCommand } from "../utils/command-runner.js";
import { LOG_ACTIONS } from "../utils/logger.js";
import { runOptimize } from "./optimize/orchestrator.js";
import type { OptimizeOpts } from "./optimize/types.js";

export const optimizeCommand = new Command("optimize")
  .description("Scan managed resources for cost-rightsizing opportunities")
  .argument("[resource-id]", "Optional ARN to optimize a single resource")
  .option(
    "--region <region>",
    "AWS region to scan (defaults to AWS_REGION env var)",
  )
  .option("--json", "Emit recommendations as JSON instead of a table")
  .option(
    "--min-savings <usd>",
    "Drop recommendations whose projected monthly savings are below this USD threshold (e.g. 10 for ≥$10/mo)",
  )
  .option("--no-color", "Disable color output")
  .addHelpText(
    "after",
    `
Examples:
  $ assignee optimize
        Scan all managed resources for rightsizing opportunities
  $ assignee optimize --region us-east-1 --min-savings 10
        Only show recommendations projecting ≥$10/mo savings
  $ assignee optimize <arn> --json
        Machine-readable output for a single resource

optimize is read-only — it prints recommendations but never mutates AWS
state. Apply changes via \`assignee plan\` / \`assignee apply\`; no --yes
flag is needed here.
`,
  )
  .action(async (resourceId: string | undefined, opts: OptimizeOpts) => {
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
  });
