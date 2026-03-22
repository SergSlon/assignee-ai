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

import * as path from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { ExecutionMode, ExecutionStatus, safeTry } from "@assignee/core";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { ProcessExitCode } from "../constants/errors.js";
import type { AgentState } from "../services/graph.js";
import { renderError, startSpinner, stopSpinner } from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { runCommand, runProvisioningLoop } from "../utils/command-runner.js";
import { SUPPORTED_TYPES_HINT, CHECKPOINT_DIR } from "../config/constants.js";
import { findNewestValidCheckpoint } from "../services/checkpoint.js";

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

    await runCommand({
      intent,
      startAction: LOG_ACTIONS.APPLY_STARTED,
      endAction: LOG_ACTIONS.APPLY_COMPLETE,
      errorPrefix: "Apply failed",
      errorHint:
        "Check that AWS credentials are configured and all MCP servers are running.",
      run: async (ctx) => {
        process.stderr.write(`[run:${ctx.runId}] Starting apply...\n`);

        const config = { configurable: { thread_id: ctx.runId } };

        // ── Checkpoint detection (AC: #3, #4) ────────────────────────────────
        const checkpointDir = path.resolve(process.cwd(), CHECKPOINT_DIR);
        const [cpErr, existingCheckpoint] = await safeTry(
          findNewestValidCheckpoint(checkpointDir),
        );

        let useCheckpoint = false;
        if (!cpErr && existingCheckpoint) {
          if (process.stdin.isTTY) {
            const confirm = await clack.confirm({
              message: `Resume from checkpoint ${existingCheckpoint.runId} (${existingCheckpoint.resourceType}, est. ${existingCheckpoint.estimatedMonthlyCost})? [Y/n]`,
              initialValue: false,
            });
            useCheckpoint = !clack.isCancel(confirm) && confirm === true;
          }

          if (useCheckpoint) {
            log({
              ts: new Date().toISOString(),
              runId: ctx.runId,
              level: "info",
              action: LOG_ACTIONS.CHECKPOINT_LOADED,
              extras: { checkpointRunId: existingCheckpoint.runId },
            });
          }
        } else if (cpErr) {
          log({
            ts: new Date().toISOString(),
            runId: ctx.runId,
            level: "warn",
            action: LOG_ACTIONS.CHECKPOINT_EXPIRED,
            extras: { error: cpErr.message },
          });
        }

        // ── Phase 1: plan + HITL confirmation ────────────────────────────────
        let phase1State: AgentState;

        if (useCheckpoint && existingCheckpoint) {
          // Skip Phase 1 — inject checkpoint state + checkpointResumed flag
          // The graph's checkpoint_router will route directly to human_approval
          phase1State = await ctx.graph.invoke(
            {
              userIntent: existingCheckpoint.userIntent,
              runId: ctx.runId,
              executionMode: ExecutionMode.APPLY,
              startedAt: Date.now(),
              resourceType: existingCheckpoint.resourceType,
              desiredState: existingCheckpoint.desiredState,
              estimatedMonthlyCost: existingCheckpoint.estimatedMonthlyCost,
              preflightPassed: existingCheckpoint.preflightPassed,
              elicitedOptions: existingCheckpoint.elicitedOptions,
              checkpointResumed: true,
            },
            config,
          );
        } else {
          startSpinner("Generating plan...");

          phase1State = await ctx.graph.invoke(
            {
              userIntent: ctx.intent,
              runId: ctx.runId,
              executionMode: ExecutionMode.APPLY,
              startedAt: Date.now(),
            },
            config,
          );
        }

        stopSpinner();

        // User declined or Ctrl+C in human_approval
        if (phase1State.executionStatus === ExecutionStatus.CANCELLED) {
          log({
            ts: new Date().toISOString(),
            runId: ctx.runId,
            level: "info",
            action: LOG_ACTIONS.APPLY_COMPLETE,
            durationMs: Date.now() - ctx.startTs,
            result: ExecutionStatus.CANCELLED,
          });
          return { success: true }; // intentional — not an error
        }

        // Early failure (intent parse, schema fetch, plan gen, preflight)
        if (
          phase1State.executionStatus === ExecutionStatus.FAILED ||
          phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
        ) {
          log({
            ts: new Date().toISOString(),
            runId: ctx.runId,
            level: "info",
            action: LOG_ACTIONS.APPLY_COMPLETE,
            durationMs: Date.now() - ctx.startTs,
            result: phase1State.executionStatus,
          });
          renderError(
            phase1State.errorMessage ?? "Apply failed during planning phase",
            phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
              ? SUPPORTED_TYPES_HINT
              : undefined,
          );
          return { success: false };
        }

        // ── Phase 2: provision all resources (single or compound loop) ────────
        const { finalState, success } = await runProvisioningLoop(
          ctx.graph,
          config,
          phase1State,
        );

        log({
          ts: new Date().toISOString(),
          runId: ctx.runId,
          level: "info",
          action: LOG_ACTIONS.APPLY_COMPLETE,
          durationMs: Date.now() - ctx.startTs,
          result: finalState.executionStatus,
        });

        return { success };
      },
    });
  });
