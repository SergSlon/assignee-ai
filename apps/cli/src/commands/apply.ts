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
 * --yes flag: auto-confirms HITL for CI/CD (Story 11.2). Preflight is never bypassed.
 * --checkpoint flag: loads a saved checkpoint, skipping Phase 1 entirely (Story 11.3).
 *
 * @see Story 2-6, Story 1-8, Story 9-6, Story 11-2, Story 11-3
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  ExecutionMode,
  ExecutionStatus,
  CheckpointError,
  AssigneeError,
  safeTry,
  BPEnforcementLevel,
} from "@assignee/core";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import type { AgentState } from "../services/graph.js";
import {
  renderError,
  startSpinner,
  stopSpinner,
  resolveSetKey,
} from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { runCommand, runProvisioningLoop } from "../utils/command-runner.js";
import {
  SUPPORTED_TYPES_HINT,
  CHECKPOINT_DIR,
  EXAMPLE_S3_INTENT,
} from "../config/constants.js";
import { ErrorCode } from "../constants/errors.js";
import {
  findNewestValidCheckpoint,
  loadCheckpointFromPath,
} from "../services/checkpoint.js";
import { checkBudget } from "../services/budget-guard.js";
import { resolveIntroContext, formatIntroContext } from "./init.js";
import { countSourceFiles } from "../utils/count-source-files.js";
import {
  loadUserConfig,
  type UserConfig,
} from "../config/user-config-loader.js";
import { loadGlobalConfig } from "../config/load-global-config.js";
import { fetchOrgPolicy, readAuthToken } from "../config/org-policy-cache.js";
import type { PlanCheckpoint } from "@assignee/core";
import { reEvaluateBP } from "../utils/bp-reeval.js";

/**
 * Builds graph initial state from a loaded checkpoint.
 * Preserves the original runId for audit trail continuity.
 *
 * Story 41.3: Re-evaluates BP rules against the checkpoint's desiredState
 * to catch rules added/modified after the original plan was generated.
 * Blocking findings update preflightPassed; findings are injected into
 * graph state so preflight_guard and result_formatter can display them.
 */
function buildCheckpointState(
  checkpoint: PlanCheckpoint,
  opts: { yes?: boolean },
  userConfig: UserConfig | undefined,
  orgConfig: unknown,
): Record<string, unknown> {
  const bpLevel =
    userConfig?.bestPractices?.enforcement ?? BPEnforcementLevel.ENFORCE;

  // Story 41.3: BP re-evaluation for checkpoint resume
  let bpFindings: ReturnType<typeof reEvaluateBP>["findings"] | undefined;
  let preflightPassed = checkpoint.preflightPassed;

  if (bpLevel !== BPEnforcementLevel.SKIP) {
    let reEval: ReturnType<typeof reEvaluateBP>;
    try {
      reEval = reEvaluateBP({
        resourceType: checkpoint.resourceType,
        desiredState: checkpoint.desiredState,
        userIntent: checkpoint.userIntent,
        patternId: checkpoint.resourcePatternId ?? undefined,
      });
    } catch {
      // BP evaluation failure in enforce mode must be fail-closed
      if (bpLevel === BPEnforcementLevel.ENFORCE) {
        preflightPassed = false;
      }
      return {
        checkpointResumed: true,
        userIntent: checkpoint.userIntent,
        runId: checkpoint.runId,
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        projectDir: process.cwd(),
        resourceType: checkpoint.resourceType,
        desiredState: checkpoint.desiredState,
        estimatedMonthlyCost: checkpoint.estimatedMonthlyCost,
        preflightPassed,
        elicitedOptions: checkpoint.elicitedOptions,
        resourceQueue: checkpoint.resourceQueue,
        bpEnforcementLevel: bpLevel,
        errorMessage:
          "BP evaluation failed — cannot verify security compliance. Re-run plan to regenerate.",
        executionStatus:
          bpLevel === BPEnforcementLevel.ENFORCE
            ? ExecutionStatus.FAILED
            : undefined,
        ...(opts.yes ? { autoApprove: true } : {}),
        ...(userConfig ? { userConfig } : {}),
        ...(orgConfig ? { orgConfig } : {}),
      };
    }

    if (reEval.findings.length > 0) {
      bpFindings = reEval.findings;

      if (bpLevel === BPEnforcementLevel.ENFORCE && reEval.hasBlocking) {
        preflightPassed = false;
        log({
          ts: new Date().toISOString(),
          runId: checkpoint.runId,
          level: "warn",
          action: LOG_ACTIONS.BP_EVALUATED,
          extras: {
            context: "checkpoint_resume",
            enforcement: BPEnforcementLevel.ENFORCE,
            blocked: true,
            blockingCount: reEval.blockingFindings.length,
            practiceIds: reEval.blockingFindings.map((f) => f.practiceId),
          },
        });
      } else if (bpLevel === BPEnforcementLevel.WARN && reEval.hasBlocking) {
        log({
          ts: new Date().toISOString(),
          runId: checkpoint.runId,
          level: "warn",
          action: LOG_ACTIONS.BP_EVALUATED,
          extras: {
            context: "checkpoint_resume",
            enforcement: BPEnforcementLevel.WARN,
            blockingCount: reEval.blockingFindings.length,
            practiceIds: reEval.blockingFindings.map((f) => f.practiceId),
          },
        });
      }
    }
  }

  return {
    checkpointResumed: true,
    userIntent: checkpoint.userIntent,
    runId: checkpoint.runId,
    executionMode: ExecutionMode.APPLY,
    startedAt: Date.now(),
    projectDir: process.cwd(),
    resourceType: checkpoint.resourceType,
    desiredState: checkpoint.desiredState,
    estimatedMonthlyCost: checkpoint.estimatedMonthlyCost,
    preflightPassed,
    elicitedOptions: checkpoint.elicitedOptions,
    resourceQueue: checkpoint.resourceQueue,
    bpEnforcementLevel: bpLevel,
    ...(bpFindings ? { bpFindings } : {}),
    ...(opts.yes ? { autoApprove: true } : {}),
    ...(userConfig ? { userConfig } : {}),
    ...(orgConfig ? { orgConfig } : {}),
  };
}

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
  .action(
    async (
      intent: string | undefined,
      opts: {
        wizard?: boolean;
        advice?: boolean;
        yes?: boolean;
        checkpoint?: string;
        source?: string;
        set?: string[];
      },
    ) => {
      // P2-R2-4: print resolved AWS context as the very first line so the
      // operator sees WHICH account/region/profile is about to be mutated
      // before any spinner / prompt / LLM call runs.
      const introCtx = await resolveIntroContext();
      process.stderr.write(
        `assignee apply  [${formatIntroContext(introCtx)}]\n`,
      );

      // ── Resolve checkpoint source ──────────────────────────────────────
      let resolvedCheckpoint: PlanCheckpoint | null = null;

      if (opts.checkpoint) {
        // Explicit --checkpoint flag: load from path, fail loudly on error
        const cpPath = path.resolve(process.cwd(), opts.checkpoint);
        try {
          resolvedCheckpoint = await loadCheckpointFromPath(cpPath);
        } catch (err) {
          if (err instanceof CheckpointError) {
            throw err;
          }
          throw new AssigneeError(
            `Checkpoint file not found: ${cpPath}. Run \`assignee plan\` to create a new plan.`,
            ErrorCode.CHECKPOINT_ERROR,
          );
        }
      } else if (!intent) {
        // No intent and no --checkpoint: attempt auto-detection
        const checkpointDir = path.resolve(process.cwd(), CHECKPOINT_DIR);
        const [cpErr, autoCheckpoint] = await safeTry(
          findNewestValidCheckpoint(checkpointDir),
        );

        if (!cpErr && autoCheckpoint) {
          // Prompt user for confirmation
          if (process.stdin.isTTY) {
            const createdDate = new Date(
              autoCheckpoint.created_at,
            ).toLocaleString();
            const confirm = await clack.confirm({
              message: `Reuse plan from ${createdDate} for '${autoCheckpoint.userIntent}'? [Y/n]`,
              initialValue: true,
            });
            if (!clack.isCancel(confirm) && confirm === true) {
              resolvedCheckpoint = autoCheckpoint;
            }
          }
        }

        // No checkpoint resolved and no intent: usage error
        if (!resolvedCheckpoint) {
          throw new AssigneeError(
            `Usage: assignee apply "${EXAMPLE_S3_INTENT}"\n` +
              "       assignee apply --checkpoint .assignee/checkpoint-<runId>.json",
            ErrorCode.USAGE_ERROR,
          );
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
      let sourceFileCount: number | undefined;
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
          process.stderr.write(
            `⚠  Source directory contains > ${sourceFileCount} files or exceeds depth limit — upload may be partial.\n`,
          );
        }
        if (sourceFileCount === 0) {
          throw new AssigneeError(
            `Source directory is empty: ${resolvedSourceDir}`,
            ErrorCode.INVALID_SOURCE_DIR,
          );
        }
      }

      // Use checkpoint intent if no intent argument provided
      const effectiveIntent = intent ?? resolvedCheckpoint?.userIntent ?? "";

      await runCommand({
        intent: effectiveIntent,
        commandName: "apply",
        startAction: LOG_ACTIONS.APPLY_STARTED,
        endAction: LOG_ACTIONS.APPLY_COMPLETE,
        errorPrefix: "Apply failed",
        errorHint:
          "Check that AWS credentials are configured and all MCP servers are running.",
        run: async (ctx) => {
          // Story 7.2: load user config + org policy before graph invocation
          const [userConfig, authToken] = await Promise.all([
            loadUserConfig(),
            readAuthToken(),
          ]);
          const orgConfig = await fetchOrgPolicy(authToken);
          // A2 + A5 (2026-04-08): merge env vars + project yaml + user
          // config into a single resolved global config so ASSIGNEE_*
          // env vars actually take effect at node-execution time (see
          // fix-applicator.ts).
          const resolvedConfig = await loadGlobalConfig(userConfig);

          const config = {
            configurable: { thread_id: ctx.runId },
            recursionLimit: 1000, // Compound patterns (up to 22 resources) × ~25 graph nodes each + RDS polling
          };

          // ── Phase 1: plan + HITL confirmation ────────────────────────────────
          let phase1State: AgentState;

          if (resolvedCheckpoint) {
            // Skip Phase 1 — inject checkpoint state + checkpointResumed flag
            // The graph's checkpoint_router will route directly to human_approval
            log({
              ts: new Date().toISOString(),
              runId: ctx.runId,
              level: "info",
              action: LOG_ACTIONS.CHECKPOINT_LOADED,
              extras: { checkpointRunId: resolvedCheckpoint.runId },
            });

            phase1State = await ctx.graph.invoke(
              buildCheckpointState(
                resolvedCheckpoint,
                opts,
                userConfig,
                orgConfig,
              ),
              config,
            );
          } else {
            // ── Auto-detect checkpoint (when intent is provided) ─────────────
            // Only offer reuse if the checkpoint intent matches the current one.
            const checkpointDir = path.resolve(process.cwd(), CHECKPOINT_DIR);
            const [cpErr, existingCheckpoint] = await safeTry(
              findNewestValidCheckpoint(checkpointDir),
            );

            let useAutoCheckpoint = false;
            const intentMatches =
              existingCheckpoint &&
              intent &&
              existingCheckpoint.userIntent.toLowerCase().trim() ===
                intent.toLowerCase().trim();
            if (!cpErr && existingCheckpoint && intentMatches) {
              if (process.stdin.isTTY) {
                const createdDate = new Date(
                  existingCheckpoint.created_at,
                ).toLocaleString();
                const confirm = await clack.confirm({
                  message: `Reuse plan from ${createdDate} for '${existingCheckpoint.userIntent}'? [Y/n]`,
                  initialValue: false,
                });
                useAutoCheckpoint =
                  !clack.isCancel(confirm) && confirm === true;
              }

              if (useAutoCheckpoint) {
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

            if (useAutoCheckpoint && existingCheckpoint) {
              phase1State = await ctx.graph.invoke(
                buildCheckpointState(
                  existingCheckpoint,
                  opts,
                  userConfig,
                  orgConfig,
                ),
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
                  projectDir: process.cwd(),
                  bpEnforcementLevel:
                    userConfig?.bestPractices?.enforcement ??
                    BPEnforcementLevel.ENFORCE,
                  ...(resolvedSourceDir
                    ? { sourceDir: resolvedSourceDir, sourceFileCount }
                    : {}),
                  ...(opts.wizard ? { noWizard: false } : {}),
                  ...(opts.advice === false ? { noAdvice: true } : {}),
                  ...(opts.yes ? { autoApprove: true } : {}),
                  ...(userConfig ? { userConfig } : {}),
                  ...(orgConfig ? { orgConfig } : {}),
                  resolvedConfig,
                  ...(opts.set?.length
                    ? {
                        presetFields: Object.fromEntries(
                          opts.set.map((kv) => {
                            const eq = kv.indexOf("=");
                            return eq > 0
                              ? [
                                  resolveSetKey(kv.slice(0, eq)),
                                  kv.slice(eq + 1),
                                ]
                              : [resolveSetKey(kv), "true"];
                          }),
                        ),
                      }
                    : {}),
                },
                config,
              );
            }
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

          // Early failure (intent parse, schema fetch, plan gen, preflight, policy)
          if (
            phase1State.executionStatus === ExecutionStatus.FAILED ||
            phase1State.executionStatus ===
              ExecutionStatus.UNSUPPORTED_RESOURCE ||
            phase1State.executionStatus === ExecutionStatus.POLICY_BLOCKED
          ) {
            log({
              ts: new Date().toISOString(),
              runId: ctx.runId,
              level: "info",
              action: LOG_ACTIONS.APPLY_COMPLETE,
              durationMs: Date.now() - ctx.startTs,
              result: phase1State.executionStatus,
            });
            // Item 4b (2026-04-10): provide a guide-the-user default
            // hint even when the downstream node didn't attach one.
            // A first-run user hitting a bare "Apply failed during
            // planning phase" had no next-step guidance — now they
            // get either the unsupported-types help or a verbose-trace
            // suggestion with the two most common root causes.
            const defaultHint =
              phase1State.executionStatus ===
              ExecutionStatus.UNSUPPORTED_RESOURCE
                ? SUPPORTED_TYPES_HINT
                : "Try rephrasing your intent, or run `assignee --verbose apply <intent>` to see which node returned FAILED. Common causes: Bedrock region mismatch, missing credentials, or an intent the LLM could not map to a supported type.";
            renderError(
              phase1State.errorMessage ??
                "Apply could not start — the planning phase did not produce a valid plan.",
              defaultHint,
            );
            return { success: false };
          }

          // BP findings blocked the apply — plan box already rendered by result_formatter
          if (
            phase1State.executionStatus === ExecutionStatus.PENDING &&
            phase1State.preflightPassed === false
          ) {
            // Story 43.2: Fix-and-continue — if interactive fixes resolved all
            // blocking findings, proceed to provisioning instead of exiting.
            const residualFindings = phase1State.bpFindings ?? [];
            const hasBlockingRemaining = residualFindings.some(
              (f) => f.blocking,
            );
            const fixesApplied =
              phase1State.appliedFixes && phase1State.appliedFixes.length > 0;

            if (fixesApplied && !hasBlockingRemaining) {
              log({
                ts: new Date().toISOString(),
                runId: ctx.runId,
                level: "info",
                action: LOG_ACTIONS.APPLY_COMPLETE,
                durationMs: Date.now() - ctx.startTs,
                result: "bp_fixed_continuing",
                extras: {
                  fixCount: phase1State.appliedFixes!.length,
                  residualFindings: residualFindings.length,
                },
              });

              // Re-invoke graph from checkpoint with fixed state → human_approval → provision
              phase1State = await ctx.graph.invoke(
                {
                  checkpointResumed: true,
                  userIntent: effectiveIntent,
                  runId: ctx.runId,
                  executionMode: ExecutionMode.APPLY,
                  startedAt: Date.now(),
                  projectDir: process.cwd(),
                  resourceType: phase1State.resourceType,
                  desiredState: phase1State.desiredState,
                  estimatedMonthlyCost: phase1State.estimatedMonthlyCost,
                  preflightPassed: true,
                  bpFindings: residualFindings,
                  appliedFixes: phase1State.appliedFixes,
                  elicitedOptions: phase1State.elicitedOptions,
                  resourceQueue: phase1State.resourceQueue,
                  resourcePattern: phase1State.resourcePattern,
                  bpEnforcementLevel:
                    userConfig?.bestPractices?.enforcement ??
                    BPEnforcementLevel.ENFORCE,
                  ...(opts.yes ? { autoApprove: true } : {}),
                  ...(userConfig ? { userConfig } : {}),
                  ...(orgConfig ? { orgConfig } : {}),
                  ...(resolvedSourceDir
                    ? { sourceDir: resolvedSourceDir, sourceFileCount }
                    : {}),
                },
                config,
              );
              // Handle user rejection during fix-and-continue re-invocation
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
              // Fall through to Phase 2 provisioning below
            } else {
              log({
                ts: new Date().toISOString(),
                runId: ctx.runId,
                level: "info",
                action: LOG_ACTIONS.APPLY_COMPLETE,
                durationMs: Date.now() - ctx.startTs,
                result: "bp_blocked",
              });
              // Exit non-zero so CI and scripts can detect blocked apply.
              // Plan box with findings is already rendered — user sees why.
              return { success: false };
            }
          }

          // Catch-all: unexpected status after phase 1 (not IN_PROGRESS, not approved)
          if (
            phase1State.executionStatus !== ExecutionStatus.IN_PROGRESS &&
            phase1State.executionStatus !== ExecutionStatus.PENDING
          ) {
            log({
              ts: new Date().toISOString(),
              runId: ctx.runId,
              level: "error",
              action: LOG_ACTIONS.APPLY_COMPLETE,
              durationMs: Date.now() - ctx.startTs,
              result: phase1State.executionStatus,
              extras: { errorMessage: phase1State.errorMessage },
            });
            // Item 4b (2026-04-10): the old fallback dumped the raw
            // LangGraph status enum at the user ("Unexpected status
            // after planning: POLICY_BLOCKED") which reads like an
            // internal assertion. The new fallback still names the
            // status (developers need it for bug reports) but frames
            // it as a next-step suggestion rather than developer-speak.
            renderError(
              phase1State.errorMessage ??
                `Apply stopped after planning in an unexpected state (${phase1State.executionStatus}).`,
              "This usually means a downstream node returned a status the apply loop doesn't know how to handle. Run `assignee --verbose apply <intent>` to capture the full node trace, then open an issue with the trace attached.",
            );
            return { success: false };
          }

          // ── Budget panic limit check (FR-09) ──────────────────────────────────
          const budgetCheck = checkBudget(
            phase1State.estimatedMonthlyCost as string | undefined,
            userConfig?.["budget"] as
              | import("@assignee/core").ConfigBudget
              | undefined,
          );
          if (budgetCheck.status === "blocked") {
            renderError(budgetCheck.message);
            return { success: false };
          }
          if (
            budgetCheck.status === "warning" ||
            budgetCheck.status === "unparseable"
          ) {
            process.stderr.write(`\u001B[33m${budgetCheck.message}\u001B[0m\n`);
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
    },
  );
