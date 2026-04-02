/**
 * `assignee plan` command — Sprint 1 demo gate.
 * Runs the graph in plan mode (no HITL, no provisioning), outputs a formatted plan box.
 *
 * @see Story 1-6, Story 1-8, Story 9-6
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  ExecutionMode,
  ExecutionStatus,
  safeTry,
  AssigneeError,
  BPEnforcementLevel,
} from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import {
  renderError,
  renderApplyNowConfirm,
  startSpinner,
  stopSpinner,
} from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { runCommand, runProvisioningLoop } from "../utils/command-runner.js";
import { SUPPORTED_TYPES_HINT, CHECKPOINT_DIR } from "../config/constants.js";
import { ErrorCode } from "../constants/errors.js";
import { serializeCheckpoint, saveCheckpoint } from "../services/checkpoint.js";
import { loadUserConfig } from "../config/user-config-loader.js";
import { fetchOrgPolicy, readAuthToken } from "../config/org-policy-cache.js";

export const planCommand = new Command(CommandName.PLAN)
  .description(CommandDescription.PLAN)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option("--no-apply", "Skip the apply prompt after plan display")
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
    `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee plan "Create an S3 bucket named my-bucket"\n  assignee plan "Create an EC2 t3.micro instance"\n  assignee plan "Create a Lambda function for image processing"`,
  )
  .action(
    async (
      intent: string | undefined,
      opts: {
        apply?: boolean;
        source?: string;
        set?: string[];
        output?: string;
      },
    ) => {
      const noApply = opts.apply === false;
      const outputFormat = opts.output ?? "text";
      // Parse --set key=value pairs into a pre-fill map
      const presetFields: Record<string, string> = {};
      for (const kv of opts.set ?? []) {
        const eqIdx = kv.indexOf("=");
        if (eqIdx > 0) {
          presetFields[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
        }
      }
      // Story 37.1: validate --source directory
      if (opts.source !== undefined && opts.source.trim() === "") {
        throw new AssigneeError(
          "--source requires a non-empty directory path",
          ErrorCode.INVALID_SOURCE_DIR,
        );
      }
      const resolvedSourceDir = opts.source
        ? path.resolve(opts.source)
        : undefined;
      let sourceFileCount = 0;
      if (resolvedSourceDir) {
        if (
          !fs.existsSync(resolvedSourceDir) ||
          !fs.statSync(resolvedSourceDir).isDirectory()
        ) {
          throw new AssigneeError(
            `Source directory does not exist: ${resolvedSourceDir}`,
            ErrorCode.INVALID_SOURCE_DIR,
          );
        }
        const countFiles = (dir: string): number => {
          let count = 0;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              count += countFiles(path.join(dir, entry.name));
            } else {
              count++;
            }
          }
          return count;
        };
        sourceFileCount = countFiles(resolvedSourceDir);
        if (sourceFileCount === 0) {
          throw new AssigneeError(
            `Source directory is empty: ${resolvedSourceDir}`,
            ErrorCode.INVALID_SOURCE_DIR,
          );
        }
      }

      if (!intent) {
        throw new AssigneeError(
          'Missing intent. Usage: assignee plan "Create an S3 bucket named my-bucket"',
          "MISSING_INTENT",
        );
      }

      await runCommand({
        intent,
        commandName: "plan",
        startAction: LOG_ACTIONS.PLAN_STARTED,
        endAction: LOG_ACTIONS.PLAN_COMPLETE,
        errorPrefix: "Plan generation failed",
        errorHint:
          "Check that AWS credentials are configured and Bedrock is accessible in your region.",
        silent: outputFormat === "json",
        run: async (ctx) => {
          // Story 7.2: load user config + org policy before graph invocation
          const [userConfig, authToken] = await Promise.all([
            loadUserConfig(),
            readAuthToken(),
          ]);
          const orgConfig = await fetchOrgPolicy(authToken);

          if (outputFormat !== "json") startSpinner("Generating plan...");

          const finalState = await ctx.graph.invoke(
            {
              userIntent: ctx.intent,
              runId: ctx.runId,
              executionMode: ExecutionMode.PLAN,
              startedAt: Date.now(),
              projectDir: process.cwd(),
              ...(resolvedSourceDir
                ? { sourceDir: resolvedSourceDir, sourceFileCount }
                : {}),
              bpEnforcementLevel:
                userConfig?.bestPractices?.enforcement ??
                BPEnforcementLevel.ENFORCE,
              ...(userConfig ? { userConfig } : {}),
              ...(orgConfig ? { orgConfig } : {}),
              ...(Object.keys(presetFields).length > 0 ? { presetFields } : {}),
              ...(outputFormat !== "text" ? { outputFormat } : {}),
            },
            { configurable: { thread_id: ctx.runId }, recursionLimit: 500 },
          );

          if (outputFormat !== "json") stopSpinner();

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
              finalState.executionStatus ===
                ExecutionStatus.UNSUPPORTED_RESOURCE
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
              if (process.stdout.isTTY && outputFormat !== "json") {
                process.stdout.write(
                  `\nPlan saved to ${CHECKPOINT_DIR}/checkpoint-${ctx.runId}.json (valid for ${checkpoint.ttl_hours}h)\n`,
                );
              }
            }
          }

          if (failed) return { success: false };

          // JSON output — plan data already written by result_formatter; skip interactive prompts
          if (outputFormat === "json") {
            return { success: true };
          }

          // ── "Apply now?" prompt (AC: #1, #2, #3) ──────────────────────────
          if (noApply || !process.stdin.isTTY) {
            return { success: true };
          }

          // Re-check blocking findings — interactive fix selection may have
          // resolved them after the original preflight (Story 35.4).
          // If bpFindings is available, check for remaining blockers;
          // if not available, trust the original preflightPassed flag.
          const currentFindings = (finalState as AgentState).bpFindings;
          const hasBlocking = currentFindings
            ? currentFindings.some((f) => f.blocking)
            : true; // no findings data → trust preflightPassed
          if (!(finalState as AgentState).preflightPassed && hasBlocking) {
            clack.log.warn(
              "Cannot apply: blocking best-practice findings detected. Fix the issues above and re-run `assignee plan`.",
            );
            return { success: true };
          }

          const applyNow = await renderApplyNowConfirm({
            resourceType: (finalState as AgentState).resourceType ?? "unknown",
            desiredState: (finalState as AgentState).desiredState,
            estimatedMonthlyCost: (finalState as AgentState)
              .estimatedMonthlyCost,
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
            recursionLimit: 500,
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
              projectDir: process.cwd(),
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
              bpFindings: planState.bpFindings,
              bpEnforcementLevel:
                userConfig?.bestPractices?.enforcement ??
                BPEnforcementLevel.ENFORCE,
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
    },
  );
