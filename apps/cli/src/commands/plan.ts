/**
 * `assignee plan` command — Sprint 1 demo gate.
 * Runs the graph in plan mode (no HITL, no provisioning), outputs a formatted plan box.
 *
 * @see Story 1-6, Story 1-8, Story 9-6
 */

import * as path from "node:path";
import { Command } from "commander";
import { ExecutionMode, ExecutionStatus, safeTry } from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { ProcessExitCode } from "../constants/errors.js";
import {
  renderError,
  renderApplyNowConfirm,
  startSpinner,
  stopSpinner,
} from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { runCommand, runProvisioningLoop } from "../utils/command-runner.js";
import { SUPPORTED_TYPES_HINT, CHECKPOINT_DIR } from "../config/constants.js";
import { serializeCheckpoint, saveCheckpoint } from "../services/checkpoint.js";

export const planCommand = new Command(CommandName.PLAN)
  .description(CommandDescription.PLAN)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option("--no-apply", "Skip the apply prompt after plan display")
  .addHelpText(
    "after",
    `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee plan "Create an S3 bucket named my-bucket"\n  assignee plan "Create an EC2 t3.micro instance"\n  assignee plan "Create a Lambda function for image processing"`,
  )
  .action(async (intent: string | undefined, opts: { apply?: boolean }) => {
    const noApply = opts.apply === false;
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

        // Save checkpoint on successful plan (AC: #1, #2, #5)
        if (!failed) {
          const checkpoint = serializeCheckpoint(finalState as AgentState);
          const checkpointDir = path.resolve(process.cwd(), CHECKPOINT_DIR);
          const [saveErr, filePath] = await safeTry(
            saveCheckpoint(checkpoint, checkpointDir),
          );
          if (saveErr) {
            log({
              ts: new Date().toISOString(),
              runId: ctx.runId,
              level: "warn",
              action: LOG_ACTIONS.CHECKPOINT_SAVED,
              result: "failed",
              extras: { error: saveErr.message },
            });
          } else {
            log({
              ts: new Date().toISOString(),
              runId: ctx.runId,
              level: "info",
              action: LOG_ACTIONS.CHECKPOINT_SAVED,
              extras: { path: filePath },
            });
            if (process.stdout.isTTY) {
              process.stdout.write(
                `\nPlan saved to ${CHECKPOINT_DIR}/checkpoint-${ctx.runId}.json (valid for ${checkpoint.ttl_hours}h)\n`,
              );
            }
          }
        }

        if (failed) return { success: false };

        // ── "Apply now?" prompt (AC: #1, #2, #3) ──────────────────────────
        if (noApply || !process.stdin.isTTY) {
          return { success: true };
        }

        const applyNow = await renderApplyNowConfirm({
          resourceType: (finalState as AgentState).resourceType ?? "unknown",
          desiredState: (finalState as AgentState).desiredState,
          estimatedMonthlyCost: (finalState as AgentState).estimatedMonthlyCost,
          runId: ctx.runId,
        });

        if (!applyNow) {
          log({
            ts: new Date().toISOString(),
            runId: ctx.runId,
            level: "info",
            action: LOG_ACTIONS.PLAN_TO_APPLY_DECLINED,
          });
          return { success: true };
        }

        // ── Plan-to-apply transition ────────────────────────────────────────
        log({
          ts: new Date().toISOString(),
          runId: ctx.runId,
          level: "info",
          action: LOG_ACTIONS.PLAN_TO_APPLY_STARTED,
        });

        const planState = finalState as AgentState;
        const applyConfig = {
          configurable: { thread_id: `${ctx.runId}-apply` },
        };

        // Phase 1: Re-invoke graph in APPLY mode with plan state injected.
        // checkpointResumed routes directly to human_approval (Story 10.1 router).
        startSpinner("Preparing to apply...");

        const phase1State = await ctx.graph.invoke(
          {
            userIntent: planState.userIntent,
            runId: ctx.runId,
            executionMode: ExecutionMode.APPLY,
            startedAt: Date.now(),
            resourceType: planState.resourceType,
            desiredState: planState.desiredState,
            estimatedMonthlyCost: planState.estimatedMonthlyCost,
            preflightPassed: planState.preflightPassed,
            elicitedOptions: planState.elicitedOptions,
            resourcePattern: planState.resourcePattern,
            resourceQueue: planState.resourceQueue,
            currentResourceIndex: planState.currentResourceIndex,
            completedResources: planState.completedResources,
            perResourceCosts: planState.perResourceCosts,
            checkpointResumed: true,
          },
          applyConfig,
        );

        stopSpinner();

        // User declined HITL confirmation
        if (phase1State.executionStatus === ExecutionStatus.CANCELLED) {
          log({
            ts: new Date().toISOString(),
            runId: ctx.runId,
            level: "info",
            action: LOG_ACTIONS.APPLY_COMPLETE,
            durationMs: Date.now() - ctx.startTs,
            result: ExecutionStatus.CANCELLED,
          });
          return { success: true };
        }

        if (
          phase1State.executionStatus === ExecutionStatus.FAILED ||
          phase1State.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
        ) {
          renderError(phase1State.errorMessage ?? "Apply failed");
          return { success: false };
        }

        // Phase 2: Provisioning loop (shared with apply.ts)
        const { finalState: applyFinalState, success: applySuccess } =
          await runProvisioningLoop(ctx.graph, applyConfig, phase1State);

        log({
          ts: new Date().toISOString(),
          runId: ctx.runId,
          level: "info",
          action: LOG_ACTIONS.APPLY_COMPLETE,
          durationMs: Date.now() - ctx.startTs,
          result: applyFinalState.executionStatus,
        });

        return { success: applySuccess };
      },
    });
  });
