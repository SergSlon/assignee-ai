/**
 * `assignee apply` command — two-phase HITL invoke pattern.
 *
 * Phase 1: graph runs intent_parser → schema_fetcher → option_elicitor →
 *          compound_dispatcher → plan_generator → preflight_guard → human_approval,
 *          then pauses (interruptBefore: resource_provisioner).
 * Phase 2: while loop — each iteration resumes from a resource_provisioner interrupt.
 *          Single-resource: one iteration. Compound: N iterations in dependency order.
 *
 * --yes flag: auto-confirms HITL for CI/CD (Story 11.2). Preflight is never bypassed.
 * --checkpoint flag: loads a saved checkpoint, skipping Phase 1 entirely (Story 11.3).
 *
 * Wave-6c F2: decomposed into `apply/` sub-modules. This file is now a thin
 * Commander wrapper + `runCommand` bridge. All real logic lives under `apply/`.
 *
 * @see Story 2-6, Story 1-8, Story 9-6, Story 11-2, Story 11-3
 */

import { Command } from "commander";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { runCommand } from "../utils/command-runner.js";
import {
  SUPPORTED_TYPES_HINT,
  EXAMPLE_S3_INTENT,
} from "../config/constants.js";
import { resolveIntroContext, formatIntroContext } from "./init.js";
import { resolveApplyArgs, type ApplyOpts } from "./apply/arg-parser.js";
import { runApply } from "./apply/orchestrator.js";

export const applyCommand = new Command(CommandName.APPLY)
  .description(CommandDescription.APPLY)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option(
    "--wizard",
    "Run interactive configuration wizard (without this flag, defaults are auto-selected from your intent)",
  )
  .option("--no-advice", "Skip inline contextual advice generation")
  .option(
    "-y, --yes",
    "Auto-confirm apply without interactive prompt (for CI/CD)",
  )
  .option(
    "-c, --checkpoint <path>",
    "Use a saved plan checkpoint instead of running Phase 1",
  )
  .option(
    "-s, --source <path>",
    "Path to local files to upload after provisioning (e.g., static site)",
  )
  .option(
    "--set <key=value...>",
    "Pre-set wizard field values (repeatable)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .addHelpText(
    "after",
    `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee apply "${EXAMPLE_S3_INTENT}"\n  assignee apply --checkpoint .assignee/checkpoint-abc123.json\n  assignee apply --wizard "Create an EC2 instance"   # interactive mode\n  assignee apply --yes "Create a Lambda function"    # CI / non-interactive\n  assignee apply --set size=t3.medium "Create an EC2 instance"`,
  )
  .action(async (intent: string | undefined, opts: ApplyOpts) => {
    // P2-R2-4: print resolved AWS context as the very first line so the
    // operator sees WHICH account/region/profile is about to be mutated
    // before any spinner / prompt / LLM call runs.
    const introCtx = await resolveIntroContext();
    process.stderr.write(`assignee apply  [${formatIntroContext(introCtx)}]\n`);

    const {
      resolvedCheckpoint,
      resolvedSourceDir,
      sourceFileCount,
      effectiveIntent,
    } = await resolveApplyArgs(intent, opts);

    await runCommand({
      intent: effectiveIntent,
      commandName: "apply",
      startAction: LOG_ACTIONS.APPLY_STARTED,
      endAction: LOG_ACTIONS.APPLY_COMPLETE,
      errorPrefix: "Apply failed",
      errorHint:
        "Check that AWS credentials are configured and all MCP servers are running.",
      run: async (ctx) =>
        runApply(ctx, {
          opts,
          intent,
          effectiveIntent,
          resolvedCheckpoint,
          resolvedSourceDir,
          sourceFileCount,
        }),
    });
  });
