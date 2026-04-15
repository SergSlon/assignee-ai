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

import { ExecutionStatus } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import type { AgentState } from "../services/graph.js";
import { PromiseStatus } from "../config/constants.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";

import {
  defaultPreflightGuards,
  runGuards,
  type GuardContext,
} from "./preflight-guard/index.js";
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
  if (guardOutcome.errorMessage) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: guardOutcome.errorMessage,
    };
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

  return {
    estimatedMonthlyCost: resolved.label,
    estimatedMonthlyCostSource: resolved.source,
    preflightPassed: !bpBlocked,
    freeTierNote: freeTierNote ?? undefined,
    ...(perResourceCosts !== undefined ? { perResourceCosts } : {}),
    ...(pricingBreakdown !== undefined ? { pricingBreakdown } : {}),
  };
}
