/**
 * preflight_guard node — LangGraph orchestrator.
 *
 * Wave 6b F2 SOLID refactor: the implementation is split into a guard
 * registry (./preflight-guard/registry.ts), a sequential runner, and a
 * pricing pipeline. This file wires them together and remains the only
 * public import surface (preserves `preflightGuardNode` for every
 * consumer and the two existing test files).
 *
 * Pricing query runs in parallel with the IAM pre-check (Story 9.10).
 * Pricing never blocks — timeout/failure falls back to the local
 * strategy estimate.
 *
 * @see Story 1-7, Story 9-4, Wave 6b F2 story
 *      (.agents/stories/wave-6b-f2-preflight-guard-solid.md)
 */

import { ExecutionStatus } from "../../index.js";
import type { StructuredTool } from "@langchain/core/tools";
import type { AgentState } from "../graph-state.js";
import type { Advisory } from "./intent-parser.js";
import { PromiseStatus } from "../../config/constants/enums.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";

import { defaultPreflightGuards } from "./preflight-guard/registry.js";
import { runGuards } from "./preflight-guard/runner.js";
import type { GuardContext } from "./preflight-guard/types.js";

/**
 * Epic 94 Wave 3 N6 (C-05 / C-06): guard IDs whose failures represent
 * "the LLM fabricated an identifier" rather than "the operator's AWS
 * account is in a bad state". Under `--no-apply` these are downgraded
 * to advisories so the preview still renders. AWS-touching guards
 * (`vpc-existence`, `managed-policy`, `iam-permissions` elsewhere) and
 * the schema-shape `required-fields` guard stay HARD failures: a
 * schema-invalid preview is not actually useful, and an AWS-side
 * posture failure signals something the preview cannot mask.
 */
const PLACEHOLDER_CLASS_GUARD_IDS = new Set<string>([
  "placeholder-arn",
  "placeholder-resource-id",
  "sentinel-password",
]);
import {
  runIamPermissionsCheck,
  type IamCheckResult,
} from "./preflight-guard/guards/iam-permissions.js";
import { evaluateBpFindings } from "./preflight-guard/guards/bp-findings.js";
import { collectFreeTierNote } from "./preflight-guard/free-tier.js";
import {
  getLocalHeadline,
  queryHeadlinePricing,
  type HeadlinePricing,
} from "./preflight-guard/pricing/headline.js";
import { runDecomposerBreakdown } from "./preflight-guard/pricing/breakdown.js";
import { resolveHeadline } from "./preflight-guard/pricing/headline-resolver.js";

export async function preflightGuardNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  const desiredState = (state.desiredState ?? {}) as Record<string, unknown>;
  const ctx: GuardContext = { state, tools, desiredState };

  // 1. Sequential guards (required-fields → placeholder-ARN → sentinel
  // password → managed-policy verification). First FAIL short-circuits.
  const guardOutcome = await runGuards(defaultPreflightGuards, ctx);
  let placeholderDowngradeAdvisory: Advisory | undefined;
  if (guardOutcome.errorMessage) {
    // Epic 94 Wave 3 N6 (C-05 / C-06): under `--no-apply` preview the
    // user explicitly asked for a read-only render. Placeholder-class
    // guard failures are downgraded to advisories so the plan box
    // still produces useful output; the apply path keeps fail-closed
    // semantics because `state.noApply` is false there.
    if (
      state.noApply === true &&
      guardOutcome.failedGuardId !== undefined &&
      PLACEHOLDER_CLASS_GUARD_IDS.has(guardOutcome.failedGuardId)
    ) {
      placeholderDowngradeAdvisory = {
        code: "PREFLIGHT_PLACEHOLDER_DOWNGRADED",
        message: guardOutcome.errorMessage,
        hint:
          "Re-run without `--no-apply` (or with concrete resource IDs) " +
          "before applying — the plan would be rejected by AWS as-is.",
        details: { guardId: guardOutcome.failedGuardId },
      };
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
        extras: {
          phase: "placeholder_downgraded_noapply",
          guardId: guardOutcome.failedGuardId,
        },
      });
    } else {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: guardOutcome.errorMessage,
      };
    }
  }

  // 2. Synchronous pre-pass work (cheap, happens before the parallel fan-
  // out so pricing + IAM can start immediately with everything ready).
  const localHeadline: HeadlinePricing = getLocalHeadline(
    state.resourceType,
    desiredState,
  );
  const { blocked: bpBlocked } = evaluateBpFindings(state);
  const freeTierNote = collectFreeTierNote(state);

  // 3. Parallel fan-out: pricing query + IAM pre-check (Story 9.10).
  // Promise.allSettled so one failure doesn't cancel the other.
  const startMs = Date.now();
  const [pricingSettled, iamSettled] = await Promise.allSettled([
    queryHeadlinePricing(
      state.resourceType,
      desiredState,
      tools,
      state.runId,
      localHeadline,
    ),
    runIamPermissionsCheck(state.resourceType, tools, state.runId),
  ]);

  const headlinePricing: HeadlinePricing =
    pricingSettled.status === PromiseStatus.FULFILLED
      ? pricingSettled.value
      : localHeadline;

  const iamResult: IamCheckResult =
    iamSettled.status === PromiseStatus.FULFILLED
      ? iamSettled.value
      : { passed: true, missing: [] };

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
    extras: {
      parallelFanOutMs: Date.now() - startMs,
      pricingStatus: pricingSettled.status,
      iamStatus: iamSettled.status,
    },
  });

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
    extras: {
      costEstimate: headlinePricing.label,
      resourceType: state.resourceType,
    },
  });

  // 4. Decomposer-driven breakdown (Story 23.6). Runs after the fan-out
  // so it can reuse the same MCP tool handle with its own per-item cache.
  const { decomposerReportedFree, breakdown: pricingBreakdown } =
    await runDecomposerBreakdown(
      state.resourceType,
      desiredState,
      tools,
      state.runId,
      state.projectDir,
    );

  // 5. Per-resource cost accumulation for compound provisioning (Story 8.3).
  let perResourceCosts: Record<string, string> | undefined;
  if (
    state.resourcePattern &&
    state.resourceQueue &&
    state.currentResourceIndex !== undefined &&
    state.currentResourceIndex >= 0 &&
    state.currentResourceIndex < state.resourceQueue.length
  ) {
    const currentResource = state.resourceQueue[state.currentResourceIndex]!;
    perResourceCosts = {
      ...(state.perResourceCosts ?? {}),
      [currentResource.resourceId]: headlinePricing.label,
    };
  }

  // 6. IAM permission gate — FAIL if any required action is denied.
  if (!iamResult.passed) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Insufficient IAM permissions. Missing actions: ${iamResult.missing.join(
        ", ",
      )}. Ask your admin to grant these permissions or use a different profile.`,
    };
  }

  // 7. Resolve the display headline: breakdown can upgrade "N/A" to a
  // real subtotal, usage-based unit price, or "Free".
  const resolved = resolveHeadline({
    headlineLabel: headlinePricing.label,
    headlineSource: headlinePricing.source,
    breakdown: pricingBreakdown,
    decomposerReportedFree,
  });

  // Epic 94 Wave 3 N6 (C-05 / C-06): merge the downgrade advisory onto
  // any advisories the intent-parser already emitted so the formatter
  // (JSON and text) sees both. `preflightPassed` stays false so the
  // plan-mode render path fires but the apply prompt / CI path sees
  // the usual "not safe to apply" signal.
  const mergedAdvisories =
    placeholderDowngradeAdvisory !== undefined
      ? [...(state.advisories ?? []), placeholderDowngradeAdvisory]
      : state.advisories;

  return {
    estimatedMonthlyCost: resolved.label,
    estimatedMonthlyCostSource: resolved.source,
    preflightPassed:
      placeholderDowngradeAdvisory !== undefined ? false : !bpBlocked,
    freeTierNote: freeTierNote ?? undefined,
    ...(perResourceCosts !== undefined ? { perResourceCosts } : {}),
    ...(pricingBreakdown !== undefined ? { pricingBreakdown } : {}),
    ...(mergedAdvisories !== undefined ? { advisories: mergedAdvisories } : {}),
  };
}
