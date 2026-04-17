/**
 * Apply Phase 1 — plan + HITL confirmation.
 *
 * Either resumes from a resolved checkpoint (explicit or auto-detected) or
 * generates a fresh plan via the graph. Stops before resource_provisioner.
 */

import * as path from "node:path";
import * as clack from "@clack/prompts";
import { ExecutionMode, BPEnforcementLevel, safeTry } from "@assignee/core";
import type { PlanCheckpoint } from "@assignee/core";
import type { AgentState } from "../../services/graph.js";
import { startSpinner } from "../../utils/display.js";
import { resolveSetKey } from "../../utils/display.js";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { CHECKPOINT_DIR } from "../../config/constants.js";
import { findNewestValidCheckpoint } from "@assignee/core/checkpoint";
import type { UserConfig } from "../../config/user-config-loader.js";
import type { CommandContext } from "../../utils/command-runner.js";
import { buildCheckpointState } from "./checkpoint-state.js";
import { parsePresetFields, type ApplyOpts } from "./arg-parser.js";

export type Phase1Context = CommandContext;

export interface Phase1Deps {
  intent: string | undefined;
  opts: ApplyOpts;
  resolvedCheckpoint: PlanCheckpoint | null;
  resolvedSourceDir: string | undefined;
  sourceFileCount: number | undefined;
  userConfig: UserConfig | undefined;
  orgConfig: unknown;
  resolvedConfig: unknown;
  graphConfig: unknown;
}

/**
 * Try to auto-detect a checkpoint matching the current intent and prompt
 * the user to reuse it. Returns the checkpoint if chosen, else null.
 */
async function tryAutoDetectCheckpoint(
  ctx: Phase1Context,
  intent: string | undefined,
): Promise<PlanCheckpoint | null> {
  const checkpointDir = path.resolve(process.cwd(), CHECKPOINT_DIR);
  const [cpErr, existingCheckpoint] = await safeTry(
    findNewestValidCheckpoint(checkpointDir),
  );

  const intentMatches =
    existingCheckpoint &&
    intent &&
    existingCheckpoint.userIntent.toLowerCase().trim() ===
      intent.toLowerCase().trim();

  if (cpErr) {
    log({
      ts: new Date().toISOString(),
      runId: ctx.runId,
      level: "warn",
      action: LOG_ACTIONS.CHECKPOINT_EXPIRED,
      extras: { error: cpErr.message },
    });
    return null;
  }

  if (!existingCheckpoint || !intentMatches) return null;

  if (!process.stdin.isTTY) return null;

  const createdDate = new Date(existingCheckpoint.created_at).toLocaleString();
  const confirm = await clack.confirm({
    message: `Reuse plan from ${createdDate} for '${existingCheckpoint.userIntent}'? [Y/n]`,
    initialValue: false,
  });
  if (clack.isCancel(confirm) || confirm !== true) return null;

  log({
    ts: new Date().toISOString(),
    runId: ctx.runId,
    level: "info",
    action: LOG_ACTIONS.CHECKPOINT_LOADED,
    extras: { checkpointRunId: existingCheckpoint.runId },
  });

  return existingCheckpoint;
}

/** Build the initial state for a fresh (non-checkpoint) plan run. */
function buildFreshPlanState(
  ctx: Phase1Context,
  deps: Phase1Deps,
): Record<string, unknown> {
  const presetFields = parsePresetFields(deps.opts.set, resolveSetKey);
  return {
    userIntent: ctx.intent,
    runId: ctx.runId,
    executionMode: ExecutionMode.APPLY,
    startedAt: Date.now(),
    projectDir: process.cwd(),
    bpEnforcementLevel:
      deps.userConfig?.bestPractices?.enforcement ?? BPEnforcementLevel.ENFORCE,
    ...(deps.resolvedSourceDir
      ? {
          sourceDir: deps.resolvedSourceDir,
          sourceFileCount: deps.sourceFileCount,
        }
      : {}),
    ...(deps.opts.wizard ? { noWizard: false } : {}),
    ...(deps.opts.advice === false ? { noAdvice: true } : {}),
    ...(deps.opts.yes ? { autoApprove: true } : {}),
    ...(deps.opts.quick === true ? { quickMode: true } : {}),
    ...(deps.userConfig ? { userConfig: deps.userConfig } : {}),
    ...(deps.orgConfig ? { orgConfig: deps.orgConfig } : {}),
    resolvedConfig: deps.resolvedConfig,
    ...(presetFields ? { presetFields } : {}),
  };
}

/**
 * Run Phase 1: either from a resolved/auto-detected checkpoint or from a
 * fresh plan generation. Returns the state AFTER Phase 1 invoke.
 */
export async function runPhase1(
  ctx: Phase1Context,
  deps: Phase1Deps,
): Promise<AgentState> {
  if (deps.resolvedCheckpoint) {
    // Explicit / prompted checkpoint — skip Phase 1.
    log({
      ts: new Date().toISOString(),
      runId: ctx.runId,
      level: "info",
      action: LOG_ACTIONS.CHECKPOINT_LOADED,
      extras: { checkpointRunId: deps.resolvedCheckpoint.runId },
    });

    return ctx.graph.invoke(
      buildCheckpointState(
        deps.resolvedCheckpoint,
        deps.opts,
        deps.userConfig,
        deps.orgConfig,
      ) as Parameters<typeof ctx.graph.invoke>[0],
      deps.graphConfig as Parameters<typeof ctx.graph.invoke>[1],
    );
  }

  // Auto-detect checkpoint matching current intent
  const autoCheckpoint = await tryAutoDetectCheckpoint(ctx, deps.intent);
  if (autoCheckpoint) {
    return ctx.graph.invoke(
      buildCheckpointState(
        autoCheckpoint,
        deps.opts,
        deps.userConfig,
        deps.orgConfig,
      ) as Parameters<typeof ctx.graph.invoke>[0],
      deps.graphConfig as Parameters<typeof ctx.graph.invoke>[1],
    );
  }

  startSpinner("Generating plan...");
  return ctx.graph.invoke(
    buildFreshPlanState(ctx, deps) as Parameters<typeof ctx.graph.invoke>[0],
    deps.graphConfig as Parameters<typeof ctx.graph.invoke>[1],
  );
}
