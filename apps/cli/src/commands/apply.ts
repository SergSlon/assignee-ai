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

import * as path from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  ExecutionMode,
  ExecutionStatus,
  CheckpointError,
  AssigneeError,
  safeTry,
} from "@assignee/core";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import type { AgentState } from "../services/graph.js";
import { renderError, startSpinner, stopSpinner } from "../utils/display.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { runCommand, runProvisioningLoop } from "../utils/command-runner.js";
import { SUPPORTED_TYPES_HINT, CHECKPOINT_DIR } from "../config/constants.js";
import {
  findNewestValidCheckpoint,
  loadCheckpointFromPath,
} from "../services/checkpoint.js";
import { loadUserConfig } from "../config/user-config-loader.js";
import { fetchOrgPolicy, readAuthToken } from "../config/org-policy-cache.js";
import type { PlanCheckpoint } from "@assignee/core";

/**
 * Builds graph initial state from a loaded checkpoint.
 * Preserves the original runId for audit trail continuity.
 */
function buildCheckpointState(
  checkpoint: PlanCheckpoint,
  opts: { yes?: boolean },
  userConfig: unknown,
  orgConfig: unknown,
): Record<string, unknown> {
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
    preflightPassed: checkpoint.preflightPassed,
    elicitedOptions: checkpoint.elicitedOptions,
    resourceQueue: checkpoint.resourceQueue,
    ...(opts.yes ? { autoApprove: true } : {}),
    ...(userConfig ? { userConfig } : {}),
    ...(orgConfig ? { orgConfig } : {}),
  };
}

export const applyCommand = new Command(CommandName.APPLY)
  .description(CommandDescription.APPLY)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option("--no-wizard", "Skip interactive option prompts, use defaults")
  .option(
    "-y, --yes",
    "Auto-confirm apply without interactive prompt (for CI/CD)",
  )
  .option(
    "-c, --checkpoint <path>",
    "Use a saved plan checkpoint instead of running Phase 1",
  )
  .addHelpText(
    "after",
    `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee apply "Create an S3 bucket named my-bucket"\n  assignee apply --checkpoint .assignee/checkpoint-abc123.json\n  assignee apply --no-wizard "Create an S3 bucket named logs-prod"\n  assignee apply "Create an EC2 t3.micro instance"\n  assignee apply "Create a Lambda function for image processing"`,
  )
  .action(
    async (
      intent: string | undefined,
      opts: { wizard?: boolean; yes?: boolean; checkpoint?: string },
    ) => {
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
            "CHECKPOINT_ERROR",
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
            'Usage: assignee apply "Create an S3 bucket named my-bucket"\n' +
              "       assignee apply --checkpoint .assignee/checkpoint-<runId>.json",
            "USAGE_ERROR",
          );
        }
      }

      // Use checkpoint intent if no intent argument provided
      const effectiveIntent = intent ?? resolvedCheckpoint?.userIntent ?? "";

      await runCommand({
        intent: effectiveIntent,
        startAction: LOG_ACTIONS.APPLY_STARTED,
        endAction: LOG_ACTIONS.APPLY_COMPLETE,
        errorPrefix: "Apply failed",
        errorHint:
          "Check that AWS credentials are configured and all MCP servers are running.",
        run: async (ctx) => {
          process.stderr.write(`[run:${ctx.runId}] Starting apply...\n`);

          // Story 7.2: load user config + org policy before graph invocation
          const [userConfig, authToken] = await Promise.all([
            loadUserConfig(),
            readAuthToken(),
          ]);
          const orgConfig = await fetchOrgPolicy(authToken);

          const config = {
            configurable: { thread_id: ctx.runId },
            recursionLimit: 500, // Compound patterns + RDS polling need many graph cycles
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
            const checkpointDir = path.resolve(process.cwd(), CHECKPOINT_DIR);
            const [cpErr, existingCheckpoint] = await safeTry(
              findNewestValidCheckpoint(checkpointDir),
            );

            let useAutoCheckpoint = false;
            if (!cpErr && existingCheckpoint) {
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
                  ...(opts.wizard === false ? { noWizard: true } : {}),
                  ...(opts.yes ? { autoApprove: true } : {}),
                  ...(userConfig ? { userConfig } : {}),
                  ...(orgConfig ? { orgConfig } : {}),
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
              phase1State.executionStatus ===
                ExecutionStatus.UNSUPPORTED_RESOURCE
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
    },
  );
