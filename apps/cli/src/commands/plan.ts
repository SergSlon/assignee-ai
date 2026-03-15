/**
 * `assignee plan` command — Sprint 1 demo gate.
 * Runs the graph in plan mode (no HITL, no provisioning), outputs a formatted plan box.
 *
 * @see Story 1-6, Story 1-8
 */

import { Command } from "commander";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { ProcessExitCode } from "../constants/errors.js";
import {
  createMcpClient,
  getMcpTools,
  closeMcpClient,
} from "../services/mcp-client.js";
import { createGraph } from "../services/graph.js";
import {
  renderIntro,
  renderError,
  renderOutro,
  startSpinner,
  stopSpinner,
} from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { SUPPORTED_TYPES_HINT } from "../config/constants.js";

export const planCommand = new Command(CommandName.PLAN)
  .description(CommandDescription.PLAN)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .action(async (intent: string | undefined) => {
    if (!intent) {
      console.error(
        'Usage: assignee plan "Create an S3 bucket named my-bucket"',
      );
      process.exit(ProcessExitCode.GENERIC_ERROR);
    }

    renderIntro();

    const runId = crypto.randomUUID();

    log({
      ts: new Date().toISOString(),
      runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_STARTED,
      intent,
    });

    try {
      const mcpClient = await createMcpClient();
      const tools = await getMcpTools(mcpClient);
      const graph = createGraph(tools);

      startSpinner("Generating plan...");

      const finalState = await graph.invoke(
        {
          userIntent: intent,
          runId,
          executionMode: ExecutionMode.PLAN,
          startedAt: Date.now(),
        },
        { configurable: { thread_id: runId } },
      );

      stopSpinner();
      await closeMcpClient();

      const failed =
        finalState.executionStatus === ExecutionStatus.FAILED ||
        finalState.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE;

      if (failed) {
        renderError(
          finalState.errorMessage ?? "Plan generation failed",
          finalState.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
            ? SUPPORTED_TYPES_HINT
            : undefined,
        );
        renderOutro(false);
        process.exit(ProcessExitCode.GENERIC_ERROR);
      }

      // result_formatter node renders the plan box in plan mode
      renderOutro(true);
      process.exit(ProcessExitCode.SUCCESS);
    } catch (err: unknown) {
      stopSpinner();
      const errMsg = err instanceof Error ? err.message : String(err);
      renderError(
        `Plan generation failed: ${errMsg}`,
        "Check that AWS credentials are configured and Bedrock is accessible in your region.",
      );
      renderOutro(false);
      await closeMcpClient();
      process.exit(ProcessExitCode.GENERIC_ERROR);
    }
  });
