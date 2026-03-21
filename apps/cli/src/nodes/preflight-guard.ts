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
  let costEstimate = defaultPricingRegistry.estimate(
    state.resourceType,
    desiredState,
  ).label;

  if (mcpConfig && tools) {
    const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
    if (pricingTool) {
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
        } else {
          const data = JSON.parse(unwrapMcpText(result)) as AwsPricingResponse;
          costEstimate =
            extractFirstTierPrice(data, mcpConfig.unit, mcpConfig.scale) ??
            CostEstimate.NA;
        }
      } catch {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.PRICING_UNAVAILABLE,
          extras: { resourceType: state.resourceType },
        });
      }
    }
  }

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

  return {
    estimatedMonthlyCost: costEstimate,
    preflightPassed: true,
    ...(perResourceCosts !== undefined ? { perResourceCosts } : {}),
  };
}
