/**
 * `assignee plan` command — Sprint 1 demo gate.
 * Runs the graph in plan mode (no HITL, no provisioning), outputs a formatted plan box.
 *
 * Wave-6d F4: decomposed into `plan/` sub-modules. This file is now a
 * thin Commander wrapper + `runCommand` bridge.
 *
 * @see Story 1-6, Story 1-8, Story 9-6
 */

import { Command } from "commander";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { LOG_ACTIONS } from "../utils/logger.js";
import { runCommand } from "../utils/command-runner.js";
import {
  SUPPORTED_TYPES_HINT,
  PLAN_GENERATION_FAILED,
  EXAMPLE_S3_INTENT,
} from "../config/constants.js";
import { resolveIntroContext, formatIntroContext } from "./init.js";
import { resolvePlanArgs, type PlanOpts } from "./plan/arg-parser.js";
import { renderDiscoveryBlock } from "./plan/discovery.js";
import { runPlan } from "./plan/orchestrator.js";

export const planCommand = new Command(CommandName.PLAN)
  .description(CommandDescription.PLAN)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option("--no-apply", "Skip the apply prompt after plan display")
  .option("--no-advice", "Skip inline contextual advice generation")
  .option(
    "-s, --source <path>",
    "Path to local files to upload after provisioning (e.g., static site)",
  )
  .option(
    "--set <key=value...>",
    "Pre-set field values, supports human names (e.g., --set size=t3.medium)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "-y, --yes",
    "Accepted for CI wrapper compatibility; plan is read-only and does not mutate.",
  )
  .option(
    "--quick",
    "Skip wizard prompts that have defaults — only ask for required fields without a default. Shows a summary gate before generating the plan.",
  )
  // Story 50-3: discovery block folded in from the removed
  // `patterns` + `types` commands. Lazily rendered via a function so
  // construction of the Command object has zero runtime cost when
  // --help is not requested.
  .addHelpText(
    "after",
    () =>
      `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee plan "${EXAMPLE_S3_INTENT}"\n  assignee plan "Create an EC2 t3.micro instance"\n  assignee plan "Create a Lambda function for image processing"\n\n${renderDiscoveryBlock()}`,
  )
  .action(async (intent: string | undefined, opts: PlanOpts) => {
    const resolved = resolvePlanArgs(intent, opts);
    const { outputFormat } = resolved;

    // P2-R2-4: print resolved AWS context before any mutation-capable
    // step so the operator always sees which account/region/profile the
    // plan will target. Suppressed in JSON mode to keep stdout clean.
    if (outputFormat !== "json") {
      const ctx = await resolveIntroContext();
      process.stderr.write(`assignee plan  [${formatIntroContext(ctx)}]\n`);
    }

    await runCommand({
      intent: intent!,
      commandName: "plan",
      startAction: LOG_ACTIONS.PLAN_STARTED,
      endAction: LOG_ACTIONS.PLAN_COMPLETE,
      errorPrefix: PLAN_GENERATION_FAILED,
      errorHint:
        "Check that AWS credentials are configured and Bedrock is accessible in your region.",
      silent: outputFormat === "json",
      run: async (ctx) =>
        runPlan(ctx, {
          ...resolved,
          intent: intent!,
          opts: { advice: opts.advice, quick: opts.quick === true },
        }),
    });
  });
