/**
 * preflight_guard node — cost estimation + basic validation gate.
 * Pricing is delegated to PricingStrategyRegistry (Story 9.4).
 * Pricing query has a 3s hard timeout (non-blocking: never blocks apply on failure).
 * SaaS policy validation is Epic 4; POC always passes.
 *
 * @see Story 1-7, Story 9-4
 */

import {
  ExecutionStatus,
  defaultPricingRegistry,
  extractFirstTierPrice,
  type AwsPricingResponse,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { AWS_REGION } from "../config/constants.js";
import { CostEstimate, PricingTerm } from "../constants/pricing.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { unwrapMcpText } from "../utils/mcp.js";
import { withTimeout } from "../utils/timeout.js";
import { getFreeTierNote, loadAccountCreatedDate } from "../utils/free-tier.js";
import { getRequiredIamActions } from "@assignee/core";
import type { AgentState } from "../services/graph.js";

const PRICING_TIMEOUT_MS = 3000;

export async function preflightGuardNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  // Validate all schema-required fields are present in the generated desiredState.
  const requiredFields =
    (state.resourceSchema?.["required"] as string[] | undefined) ?? [];
  const desiredState = (state.desiredState ?? {}) as Record<string, unknown>;
  const missingFields = requiredFields.filter((f) => !(f in desiredState));

  if (missingFields.length > 0) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Missing required fields for ${state.resourceType}: ${missingFields.join(", ")}. Include them in your intent, e.g. "Create a lambda with role arn:aws:iam::ACCOUNT_ID:role/my-role".`,
    };
  }

  const mcpConfig = defaultPricingRegistry.getMcpConfig(
    state.resourceType,
    desiredState,
  );
  const localEstimate = defaultPricingRegistry.estimate(
    state.resourceType,
    desiredState,
  ).label;

  // Story 18.10: Blocking BP findings (replaces old guardrail engine + CRITICAL BP check)
  // BP evaluation is synchronous (<1ms) — run before the parallel block.
  const bpFindings = state.bpFindings ?? [];
  const blockingFindings = bpFindings.filter(
    (f) => f.blocking || f.severity === "CRITICAL",
  );
  let bpBlocked = false;
  if (blockingFindings.length > 0) {
    bpBlocked = true;
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "warn",
      action: LOG_ACTIONS.BP_EVALUATED,
      extras: {
        blocked: true,
        blockingCount: blockingFindings.length,
        practiceIds: blockingFindings.map((f) => f.practiceId),
      },
    });
  }

  // Story 7.8: Free tier awareness — non-blocking (AC #6)
  // Synchronous — run before the parallel block.
  let freeTierNote: ReturnType<typeof getFreeTierNote> | undefined;
  try {
    const accountCreated = loadAccountCreatedDate();
    freeTierNote = getFreeTierNote(state.resourceType, accountCreated);
    if (freeTierNote) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.FREE_TIER_DETECTED,
        extras: {
          resourceType: state.resourceType,
          freeTierType: freeTierNote.type,
        },
      });
    }
  } catch {
    // Non-blocking: free tier detection failure must never prevent plan/apply
    freeTierNote = undefined;
  }

  // Story 9.10: Parallel fan-out — pricing query and IAM pre-check run concurrently.
  // Uses Promise.allSettled so one failure doesn't cancel the other.
  const startMs = Date.now();
  const [pricingSettled, iamSettled] = await Promise.allSettled([
    // Pricing query
    (async (): Promise<string> => {
      if (!mcpConfig || !tools) return localEstimate;
      const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
      if (!pricingTool) return localEstimate;
      try {
        const timeoutMs = mcpConfig.timeoutMs ?? PRICING_TIMEOUT_MS;
        const result = await withTimeout(
          pricingTool.invoke({
            service_code: mcpConfig.serviceCode,
            region: AWS_REGION,
            filters: mcpConfig.filters,
            output_options: { pricing_terms: [PricingTerm.ON_DEMAND] },
          }),
          timeoutMs,
        );
        if (result === null) {
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "warn",
            action: LOG_ACTIONS.PRICING_TIMEOUT,
            extras: { resourceType: state.resourceType, timeoutMs },
          });
          return localEstimate;
        }
        const data = JSON.parse(unwrapMcpText(result)) as AwsPricingResponse;
        return (
          extractFirstTierPrice(data, mcpConfig.unit, mcpConfig.scale) ??
          CostEstimate.NA
        );
      } catch {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.PRICING_UNAVAILABLE,
          extras: { resourceType: state.resourceType },
        });
        return localEstimate;
      }
    })(),

    // IAM pre-check
    (async (): Promise<{ passed: boolean; missing: string[] }> => {
      if (!tools || !state.resourceType) return { passed: true, missing: [] };
      const iamTool = tools.find(
        (t) => t.name === ToolName.SIMULATE_PRINCIPAL_POLICY,
      );
      if (!iamTool) return { passed: true, missing: [] };
      try {
        const requiredActions = getRequiredIamActions(state.resourceType);
        const result = await withTimeout(
          iamTool.invoke({
            action_names: requiredActions,
            resource_arns: ["*"],
          }),
          PRICING_TIMEOUT_MS,
        );
        if (result === null) return { passed: true, missing: [] };
        const simResult = JSON.parse(unwrapMcpText(result));
        const missing = (simResult.EvaluationResults ?? [])
          .filter((r: any) => r.EvalDecision !== "allowed")
          .map((r: any) => r.EvalActionName as string);
        return { passed: missing.length === 0, missing };
      } catch {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.IAM_CHECK_SKIPPED,
          extras: { resourceType: state.resourceType },
        });
        return { passed: true, missing: [] }; // Graceful degradation
      }
    })(),
  ]);

  const costEstimate =
    pricingSettled.status === "fulfilled"
      ? pricingSettled.value
      : localEstimate;

  const iamResult =
    iamSettled.status === "fulfilled"
      ? iamSettled.value
      : { passed: true, missing: [] as string[] }; // Graceful degradation

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
    extras: { costEstimate, resourceType: state.resourceType },
  });

  // Accumulate per-resource costs for compound provisioning display (Story 8.3)
  let perResourceCosts: Record<string, string> | undefined;
  if (
    state.resourcePattern &&
    state.resourceQueue &&
    state.currentResourceIndex !== undefined &&
    state.currentResourceIndex < state.resourceQueue.length
  ) {
    const currentResource = state.resourceQueue[state.currentResourceIndex]!; // bounds-checked above
    perResourceCosts = {
      ...(state.perResourceCosts ?? {}),
      [currentResource.resourceId]: costEstimate,
    };
  }

  const iamCheckPassed = iamResult.passed;
  const missingActions = iamResult.missing;

  if (!iamCheckPassed) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Insufficient IAM permissions. Missing actions: ${missingActions.join(", ")}. Ask your admin to grant these permissions or use a different profile.`,
    };
  }

  return {
    estimatedMonthlyCost: costEstimate,
    preflightPassed: !bpBlocked,
    freeTierNote: freeTierNote ?? undefined,
    ...(perResourceCosts !== undefined ? { perResourceCosts } : {}),
  };
}
