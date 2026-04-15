/**
 * Plan orchestrator — loads user/org config, invokes the graph in PLAN
 * mode, renders errors / saves checkpoint, and optionally prompts for
 * an apply follow-up.
 *
 * Wave-6d F4: split out of plan.ts.
 */
import * as clack from "@clack/prompts";
import {
  BPEnforcementLevel,
  ExecutionMode,
  ExecutionStatus,
} from "@assignee/core";
import type { AgentState } from "../../services/graph-state.js";
import {
  SUPPORTED_TYPES_HINT,
  UNKNOWN_FALLBACK,
  PLAN_GENERATION_FAILED,
} from "../../config/constants.js";
import {
  renderError,
  renderApplyNowConfirm,
  startSpinner,
  stopSpinner,
} from "../../utils/display.js";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import type { CommandContext } from "../../utils/command-runner.js";
import { loadUserConfig } from "../../config/user-config-loader.js";
import { loadGlobalConfig } from "../../config/load-global-config.js";
import {
  fetchOrgPolicy,
  readAuthToken,
} from "../../config/org-policy-cache.js";
import { checkBudget } from "../../services/budget-guard.js";
import { writePlanCheckpoint } from "./checkpoint-writer.js";
import { runPlanToApply } from "./apply-transition.js";
import type { ResolvedPlanArgs } from "./arg-parser.js";

export interface PlanRunArgs extends ResolvedPlanArgs {
  intent: string;
  opts: { advice?: boolean };
}

export async function runPlan(
  ctx: CommandContext,
  args: PlanRunArgs,
): Promise<{ success: boolean }> {
  const {
    outputFormat,
    noApply,
    presetFields,
    resolvedSourceDir,
    sourceFileCount,
    opts,
  } = args;

  // Story 7.2: load user config + org policy before graph invocation.
  const [userConfig, authToken] = await Promise.all([
    loadUserConfig(),
    readAuthToken(),
  ]);
  const orgConfig = await fetchOrgPolicy(authToken);
  // A2 + A5 (2026-04-08): merge env vars + project yaml + user config
  // into a single resolved global config so ASSIGNEE_* env vars actually
  // take effect at node-execution time.
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
        userConfig?.bestPractices?.enforcement ?? BPEnforcementLevel.ENFORCE,
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
    // Item 4b (2026-04-10): default hint when the node pipeline did
    // not attach one, so first-run users get an actionable next step
    // instead of a bare "Plan generation failed".
    const defaultHint =
      finalState.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
        ? SUPPORTED_TYPES_HINT
        : "Try rephrasing your intent, or run `assignee --verbose plan <intent>` to see the full node trace. Common causes: Bedrock region mismatch, missing credentials, or an intent the LLM could not map to a supported type.";
    renderError(finalState.errorMessage ?? PLAN_GENERATION_FAILED, defaultHint);
  }

  // Save checkpoint on successful plan (AC: #1, #2, #5)
  if (!failed) {
    await writePlanCheckpoint(finalState as AgentState, ctx, outputFormat);
  }

  if (failed) return { success: false };

  // JSON output — plan data already written by result_formatter; skip interactive prompts
  if (outputFormat === "json") {
    return { success: true };
  }

  // ── "Apply now?" prompt ────────────────────────────────────────────
  if (noApply || !process.stdin.isTTY) {
    return { success: true };
  }

  // Re-check blocking findings — interactive fix selection may have
  // resolved them after the original preflight (Story 35.4). If
  // bpFindings is available, check for remaining blockers; if not,
  // trust the original preflightPassed flag.
  const state = finalState as AgentState;
  const currentFindings = state.bpFindings;
  const hasBlocking = currentFindings
    ? currentFindings.some((f) => f.blocking)
    : true;
  if (!state.preflightPassed && hasBlocking) {
    clack.log.warn(
      "Cannot apply: blocking best-practice findings detected. Fix the issues above and re-run `assignee plan`.",
    );
    return { success: false };
  }

  // ── Budget panic limit check (FR-09) ─────────────────────────────
  const budgetCheck = checkBudget(
    state.estimatedMonthlyCost,
    userConfig?.["budget"] as import("@assignee/core").ConfigBudget | undefined,
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
    resourceType: state.resourceType ?? UNKNOWN_FALLBACK,
    desiredState: state.desiredState,
    estimatedMonthlyCost: state.estimatedMonthlyCost,
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

  return runPlanToApply({ ctx, planState: state, userConfig });
}
