/**
 * Plan orchestrator — loads user/org config, invokes the graph in PLAN
 * mode, renders errors / saves checkpoint, and optionally prompts for
 * an apply follow-up.
 *
 * Wave-6d F4: split out of plan.ts.
 */
import * as clack from "@clack/prompts";
import {
  AssigneeError,
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
  renderHitlConfirm,
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
import { checkMonthlyCostBudget } from "../../services/budget-guard.js";
import { askClarifyingQuestion } from "../../services/clarifier.js";
import { writePlanCheckpoint } from "./checkpoint-writer.js";
import { runPlanToApply } from "./apply-transition.js";
import type { ResolvedPlanArgs } from "./arg-parser.js";

export interface PlanRunArgs extends ResolvedPlanArgs {
  intent: string;
  opts: { advice?: boolean; quick?: boolean };
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

  // Plan runs at most twice: once for the initial intent, optionally a
  // second time if the first invocation fails at intent-ambiguity and the
  // operator rephrases via the clarifier (Story 52-1). The retry is
  // strictly one-shot — we never loop.
  type PlanState = Awaited<ReturnType<typeof ctx.graph.invoke>>;
  const invokePlan = async (intent: string): Promise<PlanState> => {
    if (outputFormat !== "json") startSpinner("Generating plan...");
    const s = await ctx.graph.invoke(
      {
        userIntent: intent,
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
        ...(opts.quick === true ? { quickMode: true } : {}),
        // Epic 94 Wave 3 N6 (C-05 / C-06): forward `--no-apply` into
        // the graph so `preflight_guard` can downgrade placeholder-
        // class rejections into advisories and let the preview render.
        // Default behaviour (apply-capable) is preserved when the flag
        // is absent because `noApply` defaults to false in the state
        // annotation.
        ...(noApply ? { noApply: true } : {}),
        ...(userConfig ? { userConfig } : {}),
        ...(orgConfig ? { orgConfig } : {}),
        resolvedConfig,
        ...(Object.keys(presetFields).length > 0 ? { presetFields } : {}),
        ...(outputFormat !== "text" ? { outputFormat } : {}),
      },
      { configurable: { thread_id: ctx.runId }, recursionLimit: 1000 },
    );
    if (outputFormat !== "json") stopSpinner();
    return s;
  };

  let finalState = await invokePlan(ctx.intent);

  let failed =
    finalState.executionStatus === ExecutionStatus.FAILED ||
    finalState.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE;

  // Story 52-1: if plan failed on an ambiguous intent, offer one
  // clarifying rephrase before surfacing the existing error. No-op in
  // --quick / --yes / non-TTY / non-intent-failure modes.
  if (failed && outputFormat !== "json") {
    const rephrased = await askClarifyingQuestion({
      state: finalState as AgentState,
      autoApprove: false,
      quick: opts.quick === true,
    });
    if (rephrased) {
      ctx.intent = rephrased;
      finalState = await invokePlan(rephrased);
      failed =
        finalState.executionStatus === ExecutionStatus.FAILED ||
        finalState.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE;
    }
  }

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

  if (failed) {
    // Epic 94 R1 (A-01) + R5 (C-03): when the graph surfaces a typed
    // error (e.g. INVALID_DESIRED_STATE from validate_desired_state),
    // propagate its code so the JSON-envelope path in plan.ts can stamp
    // the stable machine-readable code on stdout. In text mode,
    // renderError above already wrote the human message; runCommand is
    // silent in JSON mode so there is no double render.
    //
    // R5 broadening: also throw when `state.error` is NOT an
    // AssigneeError (e.g. intent-parser's UNSUPPORTED_RESOURCE path
    // sets `executionStatus` + `errorMessage` but never attaches a
    // typed `state.error`). Without a throw, runCommand returns
    // gracefully and the stdout interceptor's flushSuccess hits its
    // "no payloads were buffered" fallback — which emits the generic
    // `PLAN_FAILED` envelope and loses the real code. Derive the code
    // from `executionStatus` so UNSUPPORTED_RESOURCE stays
    // UNSUPPORTED_RESOURCE on the wire.
    const stateError = (finalState as AgentState).error;
    if (outputFormat === "json") {
      if (stateError instanceof AssigneeError) {
        throw stateError;
      }
      const derivedCode =
        finalState.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE
          ? "UNSUPPORTED_RESOURCE"
          : "PLAN_FAILED";
      const derivedMessage = finalState.errorMessage ?? PLAN_GENERATION_FAILED;
      throw new AssigneeError(derivedMessage, derivedCode);
    }
    return { success: false };
  }

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
  const budgetCheck = checkMonthlyCostBudget(
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

  // Story 50-2: single unified confirm — renderApplyNowConfirm was collapsed
  // into renderHitlConfirm. The second prompt on the apply side is gated by
  // checkpointResumed=true in runPlanToApply, so the user sees ONE confirm
  // on the plan→apply happy path.
  const applyNow = await renderHitlConfirm({
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
