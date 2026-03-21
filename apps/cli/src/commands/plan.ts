/**
 * `assignee plan` command — Sprint 1 demo gate.
 * Runs the graph in plan mode (no HITL, no provisioning), outputs a formatted plan box.
 *
 * @see Story 1-6, Story 1-8, Story 9-6
 */

import { Command } from "commander";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { ProcessExitCode } from "../constants/errors.js";
import { renderError, startSpinner, stopSpinner } from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { runCommand } from "../utils/command-runner.js";
import { SUPPORTED_TYPES_HINT } from "../config/constants.js";

export const planCommand = new Command(CommandName.PLAN)
  .description(CommandDescription.PLAN)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .addHelpText(
    "after",
    `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee plan "Create an S3 bucket named my-bucket"\n  assignee plan "Create an EC2 t3.micro instance"\n  assignee plan "Create a Lambda function for image processing"`,
  )
  .action(async (intent: string | undefined) => {
    if (!intent) {
      console.error(
        'Usage: assignee plan "Create an S3 bucket named my-bucket"',
      );
      process.exit(ProcessExitCode.GENERIC_ERROR);
    }

    await runCommand({
      intent,
      startAction: LOG_ACTIONS.PLAN_STARTED,
      endAction: LOG_ACTIONS.PLAN_COMPLETE,
      errorPrefix: "Plan generation failed",
      errorHint:
        "Check that AWS credentials are configured and Bedrock is accessible in your region.",
      run: async (ctx) => {
        startSpinner("Generating plan...");

        const finalState = await ctx.graph.invoke(
          {
            userIntent: ctx.intent,
            runId: ctx.runId,
            executionMode: ExecutionMode.PLAN,
            startedAt: Date.now(),
          },
          { configurable: { thread_id: ctx.runId } },
        );

        stopSpinner();

        const failed =
          finalState.executionStatus === ExecutionStatus.FAILED ||
          finalState.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE;

        log({
          ts: new Date().toISOString(),
          runId: ctx.runId,
          level: "info",
          action: LOG_ACTIONS.PLAN_COMPLETE,
          durationMs: Date.now() - ctx.startTs,
          result: finalState.executionStatus,
        });

        if (failed) {
          renderError(
            finalState.errorMessage ?? "Plan generation failed",
            finalState.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
              ? SUPPORTED_TYPES_HINT
              : undefined,
          );
        }

        return { success: !failed };
      },
    });
  });
