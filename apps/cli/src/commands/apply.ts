/**
 * `assignee apply` command — two-phase HITL invoke pattern.
 *
 * Phase 1: graph runs intent_parser → schema_fetcher → plan_generator →
 *          preflight_guard → human_approval, then pauses (interruptBefore: resource_provisioner).
 * Phase 2: if user confirmed, graph resumes from resource_provisioner →
 *          status_poller → result_formatter.
 *
 * No --yes flag: HITL is mandatory per spec.
 *
 * @see Story 2-6, Story 1-8
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
  updateSpinner,
  stopSpinner,
} from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { SUPPORTED_TYPES_HINT } from "../config/constants.js";

export const applyCommand = new Command(CommandName.APPLY)
  .description(CommandDescription.APPLY)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .addHelpText(
    "after",
    `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee apply "Create an S3 bucket named my-bucket"\n  assignee apply "Create an EC2 t3.micro instance"\n  assignee apply "Create a Lambda function for image processing"`,
  )
  .action(async (intent: string | undefined) => {
    if (!intent) {
      console.error(
        'Usage: assignee apply "Create an S3 bucket named my-bucket"',
      );
      process.exit(ProcessExitCode.GENERIC_ERROR);
    }

    renderIntro();

    const runId = crypto.randomUUID();

    log({
      ts: new Date().toISOString(),
      runId,
      level: "info",
      action: LOG_ACTIONS.APPLY_STARTED,
      intent,
    });

    process.stderr.write(`[run:${runId}] Starting apply...\n`);

    try {
      const mcpClient = await createMcpClient();
      const tools = await getMcpTools(mcpClient);
      const graph = createGraph(tools);

      const config = { configurable: { thread_id: runId } };

      // ── Phase 1: plan + HITL confirmation ────────────────────────────────
      startSpinner("Generating plan...");

      const phase1State = await graph.invoke(
        {
          userIntent: intent,
          runId,
          executionMode: ExecutionMode.APPLY,
          startedAt: Date.now(),
        },
        config,
      );

      stopSpinner();

      // User declined or Ctrl+C in human_approval
      if (phase1State.executionStatus === ExecutionStatus.CANCELLED) {
        renderOutro(true); // intentional — not an error
        await closeMcpClient();
        process.exit(ProcessExitCode.SUCCESS);
      }

      // Early failure (intent parse, schema fetch, plan gen, preflight)
      if (
        phase1State.executionStatus === ExecutionStatus.FAILED ||
        phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
      ) {
        renderError(
          phase1State.errorMessage ?? "Apply failed during planning phase",
          phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
            ? SUPPORTED_TYPES_HINT
            : undefined,
        );
        renderOutro(false);
        await closeMcpClient();
        process.exit(ProcessExitCode.GENERIC_ERROR);
      }

      // ── Phase 2: provision ────────────────────────────────────────────────
      startSpinner("Provisioning resource...");
      updateSpinner("Waiting for AWS Cloud Control API...");

      const finalState = await graph.invoke(null, config);

      stopSpinner();

      await closeMcpClient();

      const success = finalState.executionStatus === ExecutionStatus.SUCCESS;
      renderOutro(success);
      process.exit(
        success ? ProcessExitCode.SUCCESS : ProcessExitCode.GENERIC_ERROR,
      );
    } catch (err: unknown) {
      stopSpinner();
      const errMsg = err instanceof Error ? err.message : String(err);
      renderError(
        `Apply failed: ${errMsg}`,
        "Check that AWS credentials are configured and all MCP servers are running.",
      );
      renderOutro(false);
      await closeMcpClient();
      process.exit(ProcessExitCode.GENERIC_ERROR);
    }
  });
