/**
 * Apply orchestrator — wires Phase 1 → gate → Phase 2 provisioning.
 *
 * Called from the `run` callback handed to runCommand().
 */

import { stopSpinner } from "../../utils/display.js";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { runProvisioningLoop } from "../../utils/command-runner.js";
import { loadUserConfig } from "../../config/user-config-loader.js";
import { loadGlobalConfig } from "../../config/load-global-config.js";
import {
  fetchOrgPolicy,
  readAuthToken,
} from "../../config/org-policy-cache.js";
import type { PlanCheckpoint } from "@assignee/core";
import type { CommandContext } from "../../utils/command-runner.js";
import { runPhase1, type Phase1Deps } from "./phase1-planner.js";
import { handlePhase1Outcome } from "./phase1-gate.js";
import type { ApplyOpts } from "./arg-parser.js";

export type OrchestratorCtx = CommandContext;

export interface OrchestratorArgs {
  opts: ApplyOpts;
  intent: string | undefined;
  effectiveIntent: string;
  resolvedCheckpoint: PlanCheckpoint | null;
  resolvedSourceDir: string | undefined;
  sourceFileCount: number | undefined;
}

/**
 * End-to-end apply run: load user/org config, run Phase 1, handle the
 * outcome (early-exit or continue), then run Phase 2 provisioning loop.
 */
export async function runApply(
  ctx: OrchestratorCtx,
  args: OrchestratorArgs,
): Promise<{ success: boolean }> {
  // Story 7.2: load user config + org policy before graph invocation
  const [userConfig, authToken] = await Promise.all([
    loadUserConfig(),
    readAuthToken(),
  ]);
  const orgConfig = await fetchOrgPolicy(authToken);
  // A2 + A5 (2026-04-08): merge env vars + project yaml + user config
  const resolvedConfig = await loadGlobalConfig(userConfig);

  const graphConfig = {
    configurable: { thread_id: ctx.runId },
    // Compound patterns (up to 22 resources) × ~25 graph nodes each + RDS polling
    recursionLimit: 1000,
  };

  const deps: Phase1Deps = {
    intent: args.intent,
    opts: args.opts,
    resolvedCheckpoint: args.resolvedCheckpoint,
    resolvedSourceDir: args.resolvedSourceDir,
    sourceFileCount: args.sourceFileCount,
    userConfig,
    orgConfig,
    resolvedConfig,
    graphConfig,
  };

  // ── Phase 1: plan + HITL confirmation ─────────────────────────────
  const phase1State = await runPhase1(ctx, deps);
  stopSpinner();

  const gate = await handlePhase1Outcome(
    ctx,
    deps,
    phase1State,
    args.effectiveIntent,
  );
  if (gate.kind === "done") return gate.result;

  // ── Phase 2: provision all resources ──────────────────────────────
  const { finalState, success } = await runProvisioningLoop(
    ctx.graph,
    graphConfig,
    gate.phase1State,
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
}
