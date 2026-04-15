/**
 * Top-level billing-data fetch with graceful-degradation chain:
 *   1. Billing MCP (live)
 *   2. Provision-log memory (historical estimates)
 *   3. Empty map (cost shows "N/A")
 *
 * Extracted from billing.ts during Wave-6c decomposition.
 *
 * @see Story 19.7
 * @see Story 46.2 — provenance tag
 */

import type { StructuredTool } from "@langchain/core/tools";
import { CostEstimateLabel } from "@assignee/core";
import { AWS_REGION, UNKNOWN_FALLBACK } from "../../config/constants.js";
import type { ManagedResource } from "../list-resources.js";
import { defaultMemoryService } from "../memory.js";
import { queryBillingMcp } from "./cost-explorer.js";
import { logBillingMcpFailure } from "./error-handler.js";
import type { BillingCostData } from "./types.js";

/**
 * Fetches live billing data for managed resources from the Billing MCP server.
 * Falls back to provision log memory if MCP is unavailable.
 */
export async function fetchBillingData(
  resources: ManagedResource[],
  mcpTools?: StructuredTool[],
): Promise<Map<string, BillingCostData>> {
  const costMap = new Map<string, BillingCostData>();

  // Try Billing MCP server first
  if (mcpTools && mcpTools.length > 0) {
    try {
      const billingData = await queryBillingMcp(resources, mcpTools);
      for (const entry of billingData) {
        costMap.set(entry.arn, entry);
      }
      if (costMap.size > 0) return costMap;
    } catch (err) {
      // MCP unavailable — fall through to memory fallback. Log at warn so
      // operators can correlate "offline" provenance rows with the root cause.
      logBillingMcpFailure("fetchBillingData.queryBillingMcp", err);
    }
  }

  // Fallback: provision log memory
  // Story 46.2: tag every fallback row "offline" so the user can tell at a
  // glance that they're looking at log replay, not live AWS data.
  const provisions = await defaultMemoryService.readProvisions();
  for (const p of provisions) {
    if (p.resourceArn && p.estimatedMonthlyCost) {
      costMap.set(p.resourceArn, {
        arn: p.resourceArn,
        actualMonthlyCost: p.estimatedMonthlyCost,
        forecastedMonthlyCost: p.estimatedMonthlyCost,
        currency: "USD",
        lastUpdated: p.timestamp,
        source: "offline",
      });
    }
  }

  return costMap;
}

/**
 * Gets cost savings estimate for a specific resource.
 * Used by `assignee destroy` to show savings when removing a resource.
 *
 * @returns Formatted string like "$X.XX/month saved" or "N/A" on failure.
 */
export async function getCostSavingsEstimate(
  arn: string,
  mcpTools?: StructuredTool[],
): Promise<string> {
  try {
    const dummyResource: ManagedResource = {
      resourceType: UNKNOWN_FALLBACK,
      arn,
      region: AWS_REGION,
      createdDate: CostEstimateLabel.NA,
      estimatedMonthlyCost: CostEstimateLabel.NA,
    };

    const costMap = await fetchBillingData([dummyResource], mcpTools);
    const data = costMap.get(arn);
    if (data) {
      return `${data.actualMonthlyCost} saved`;
    }
  } catch (err) {
    logBillingMcpFailure("getCostSavingsEstimate", err);
    // Graceful degradation
  }

  return CostEstimateLabel.NA;
}
