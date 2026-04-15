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
  resolveSetKey,
} from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { runCommand, runProvisioningLoop } from "../utils/command-runner.js";
import { countSourceFiles } from "../utils/count-source-files.js";
import {
  SUPPORTED_TYPES_HINT,
  CHECKPOINT_DIR,
  UNKNOWN_FALLBACK,
  PLAN_GENERATION_FAILED,
  EXAMPLE_S3_INTENT,
} from "../config/constants.js";
import { ErrorCode } from "../constants/errors.js";
import { serializeCheckpoint, saveCheckpoint } from "../services/checkpoint.js";
import { checkBudget } from "../services/budget-guard.js";
import { loadUserConfig } from "../config/user-config-loader.js";
import { loadGlobalConfig } from "../config/load-global-config.js";
import { fetchOrgPolicy, readAuthToken } from "../config/org-policy-cache.js";
import { resolveIntroContext, formatIntroContext } from "./init.js";

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
  .addHelpText(
    "after",
    `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee plan "${EXAMPLE_S3_INTENT}"\n  assignee plan "Create an EC2 t3.micro instance"\n  assignee plan "Create a Lambda function for image processing"`,
  )
  .action(
    async (
      intent: string | undefined,
      opts: {
        apply?: boolean;
        advice?: boolean;
        source?: string;
        set?: string[];
        output?: string;
        yes?: boolean;
      },
    ) => {
      const noApply = opts.apply === false;
      const outputFormat = opts.output ?? "text";
      // Parse --set key=value pairs into a pre-fill map (supports human names)
      const presetFields: Record<string, string> = {};
      for (const kv of opts.set ?? []) {
        const eqIdx = kv.indexOf("=");
        if (eqIdx > 0) {
          const rawKey = kv.slice(0, eqIdx);
          presetFields[resolveSetKey(rawKey)] = kv.slice(eqIdx + 1);
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
        const { count, truncated } = countSourceFiles(resolvedSourceDir);
        sourceFileCount = count;
        if (truncated) {
          clack.log.warn(
            `Source directory contains > ${sourceFileCount} files or exceeds depth limit — upload may be partial.`,
          );
        }
        if (sourceFileCount === 0) {
          throw new AssigneeError(
            `Source directory is empty: ${resolvedSourceDir}`,
            ErrorCode.INVALID_SOURCE_DIR,
          );
        }
      }

      if (!intent) {
        throw new AssigneeError(
          `Missing intent. Usage: assignee plan "${EXAMPLE_S3_INTENT}"`,
          "MISSING_INTENT",
        );
      }

      // P2-R2-4: print resolved AWS context before any mutation-capable
      // step so the operator always sees which account/region/profile the
      // plan will target. Suppressed in JSON mode to keep stdout clean.
      if (outputFormat !== "json") {
        const ctx = await resolveIntroContext();
        process.stderr.write(`assignee plan  [${formatIntroContext(ctx)}]\n`);
      }

      await runCommand({
        intent,
        commandName: "plan",
        startAction: LOG_ACTIONS.PLAN_STARTED,
        endAction: LOG_ACTIONS.PLAN_COMPLETE,
        errorPrefix: PLAN_GENERATION_FAILED,
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
          // A2 + A5 (2026-04-08): merge env vars + project yaml + user
          // config into a single resolved global config so ASSIGNEE_*
          // env vars actually take effect at node-execution time.
          const resolvedConfig = await loadGlobalConfig(userConfig);

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
              ...(opts.advice === false ? { noAdvice: true } : {}),
              ...(userConfig ? { userConfig } : {}),
              ...(orgConfig ? { orgConfig } : {}),
              resolvedConfig,
              ...(Object.keys(presetFields).length > 0 ? { presetFields } : {}),
              ...(outputFormat !== "text" ? { outputFormat } : {}),
            },
            { configurable: { thread_id: ctx.runId }, recursionLimit: 1000 },
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
            // Item 4b (2026-04-10): supply a default guide-the-user hint
            // when the node pipeline didn't attach one. Previous behavior
            // left the user with a bare "Plan generation failed" and no
            // actionable next step — a first-run user would have to read
            // the stack trace to guess what went wrong.
            const defaultHint =
              finalState.executionStatus ===
              ExecutionStatus.UNSUPPORTED_RESOURCE
                ? SUPPORTED_TYPES_HINT
                : "Try rephrasing your intent, or run `assignee --verbose plan <intent>` to see the full node trace. Common causes: Bedrock region mismatch, missing credentials, or an intent the LLM could not map to a supported type.";
            renderError(
              finalState.errorMessage ?? PLAN_GENERATION_FAILED,
              defaultHint,
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
            // Exit non-zero so CI/scripts can detect blocking findings
            return { success: false };
          }

          // ── Budget panic limit check (FR-09) ─────────────────────────────
          const budgetCheck = checkBudget(
            (finalState as AgentState).estimatedMonthlyCost,
            userConfig?.["budget"] as
              | import("@assignee/core").ConfigBudget
              | undefined,
          );
          if (budgetCheck.status === "blocked") {
            clack.log.error(budgetCheck.message);
            return { success: false };
          }
          if (budgetCheck.status === "warning") {
            clack.log.warn(budgetCheck.message);
          }
          if (budgetCheck.status === "unparseable") {
            // Fail-closed: surface a visible warning. User must review manually.
            clack.log.warn(budgetCheck.message);
          }

          const applyNow = await renderApplyNowConfirm({
            resourceType:
              (finalState as AgentState).resourceType ?? UNKNOWN_FALLBACK,
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
            // Item 4b (2026-04-10): the old "Apply failed" fallback
            // was both blame-flavored and uninformative. Callers hit
            // this branch when the LLM couldn't map the intent or a
            // downstream node (schema-fetcher, option-elicitor,
            // bp-evaluator) returned FAILED without a node-specific
            // error message. The new hint guides the user to the two
            // most productive next actions: regenerate the plan or
            // enable verbose node tracing.
            renderError(
              phase1State.errorMessage ??
                "Apply could not start — the planning phase did not produce a valid plan.",
              "Run `assignee plan <intent>` first to see the full node trace. If the plan succeeds there, re-run `assignee apply` against the saved checkpoint in .assignee/. If the plan also fails, add `--verbose` to surface which node returned FAILED.",
            );
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
