/**
 * `assignee apply` command — two-phase HITL invoke pattern.
 *
 * Phase 1: graph runs intent_parser → schema_fetcher → option_elicitor →
 *          compound_dispatcher → plan_generator → preflight_guard → human_approval,
 *          then pauses (interruptBefore: resource_provisioner).
 * Phase 2: while loop — each iteration resumes from a resource_provisioner interrupt.
 *          Single-resource: one iteration (→ status_poller → result_formatter → END).
 *          Compound: N iterations, one per resource in dependency order; human_approval
 *          is skipped for iterations 2+ (already approved at index 0).
 *
 * No --yes flag: HITL is mandatory per spec.
 *
 * @see Story 2-6, Story 1-8, Story 9-6
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
import { createGraph, type AgentState } from "../services/graph.js";
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
    const startTs = Date.now();

    log({
      ts: new Date().toISOString(),
      runId,
      level: "info",
      action: LOG_ACTIONS.APPLY_STARTED,
      extras: { intent },
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
        log({
          ts: new Date().toISOString(),
          runId,
          level: "info",
          action: LOG_ACTIONS.APPLY_COMPLETE,
          durationMs: Date.now() - startTs,
          result: ExecutionStatus.CANCELLED,
        });
        renderOutro(true); // intentional — not an error
        await closeMcpClient();
        process.exit(ProcessExitCode.SUCCESS);
      }

      // Early failure (intent parse, schema fetch, plan gen, preflight)
      if (
        phase1State.executionStatus === ExecutionStatus.FAILED ||
        phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
      ) {
        log({
          ts: new Date().toISOString(),
          runId,
          level: "info",
          action: LOG_ACTIONS.APPLY_COMPLETE,
          durationMs: Date.now() - startTs,
          result: phase1State.executionStatus,
        });
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

      // ── Phase 2: provision all resources (single or compound loop) ────────
      const isCompound = !!phase1State.resourcePattern;
      const totalResources = phase1State.resourceQueue?.length ?? 1;
      let resourcesProvisioned = 0;

      while (true) {
        const resourceLabel = isCompound
          ? `Provisioning resource ${resourcesProvisioned + 1} of ${totalResources} (${phase1State.resourceQueue?.[resourcesProvisioned]?.displayName ?? "..."})...`
          : "Provisioning resource...";
        startSpinner(resourceLabel);
        updateSpinner("Waiting for AWS Cloud Control API...");

        await graph.invoke(null, config);
        stopSpinner();

        // Check if graph has completed (next === []) or is paused at another interrupt
        const graphState = await graph.getState(config);
        const isPendingInterrupt = graphState.next.length > 0;

        if (!isPendingInterrupt) break; // Graph reached END

        // Another resource_provisioner interrupt pending (compound loop)
        resourcesProvisioned++;
      }

      // Retrieve final state for exit code determination
      const finalState = (await graph.getState(config)).values as AgentState;

      await closeMcpClient();

      const success =
        finalState.executionStatus === ExecutionStatus.SUCCESS ||
        (isCompound &&
          (finalState.completedResources?.length ?? 0) === totalResources);

      log({
        ts: new Date().toISOString(),
        runId,
        level: "info",
        action: LOG_ACTIONS.APPLY_COMPLETE,
        durationMs: Date.now() - startTs,
        result: finalState.executionStatus,
      });

      renderOutro(success);
      process.exit(
        success ? ProcessExitCode.SUCCESS : ProcessExitCode.GENERIC_ERROR,
      );
    } catch (err: unknown) {
      stopSpinner();
      const errMsg = err instanceof Error ? err.message : String(err);
      log({
        ts: new Date().toISOString(),
        runId,
        level: "error",
        action: LOG_ACTIONS.APPLY_COMPLETE,
        durationMs: Date.now() - startTs,
        result: "error",
      });
      renderError(
        `Apply failed: ${errMsg}`,
        "Check that AWS credentials are configured and all MCP servers are running.",
      );
      renderOutro(false);
      await closeMcpClient();
      process.exit(ProcessExitCode.GENERIC_ERROR);
    }
  });
