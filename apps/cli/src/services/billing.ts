/**
 * Billing data service — fetches live cost data from the AWS Cost Management MCP server.
 *
 * Graceful degradation chain:
 *   1. Billing MCP (live) — get_cost_and_usage tool
 *   2. Provision log memory (historical estimates)
 *   3. Empty map (cost shows "N/A")
 *
 * @see Story 19.7
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { defaultMemoryService } from "./memory.js";
import { unwrapMcpText } from "../utils/mcp.js";
import type { ManagedResource } from "./list-resources.js";

export interface BillingCostData {
  arn: string;
  actualMonthlyCost: string;
  forecastedMonthlyCost: string;
  currency: string;
  lastUpdated: string;
}

/**
 * Builds a date range covering the current calendar month.
 * The Cost Explorer API requires Start (inclusive) and End (exclusive).
 */
function currentMonthRange(): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  const start = `${year}-${String(month + 1).padStart(2, "0")}-01`;

  // End is exclusive — first day of next month
  const nextMonth = month + 1;
  const endYear = nextMonth > 11 ? year + 1 : year;
  const endMonth = nextMonth > 11 ? 1 : nextMonth + 1;
  const end = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

  return { start, end };
}

/**
 * Queries the Billing MCP server's get_cost_and_usage tool for resource costs.
 * Returns an array of BillingCostData entries. Returns empty array on any error.
 */
async function queryBillingMcp(
  resources: ManagedResource[],
  mcpTools: StructuredTool[],
): Promise<BillingCostData[]> {
  const costTool = mcpTools.find((t) => t.name === ToolName.GET_COST_AND_USAGE);
  if (!costTool) return [];

  const arns = resources.map((r) => r.arn);
  const { start, end } = currentMonthRange();

  const response = await costTool.invoke({
    time_period: { Start: start, End: end },
    granularity: "MONTHLY",
    filter: {
      Dimensions: {
        Key: "RESOURCE_ID",
        Values: arns,
      },
    },
    metrics: ["UnblendedCost"],
  });

  const text = unwrapMcpText(response);
  const parsed = JSON.parse(text);

  const results: BillingCostData[] = [];

  // Parse Cost Explorer response format
  if (parsed?.ResultsByTime) {
    for (const timePeriod of parsed.ResultsByTime) {
      if (timePeriod?.Groups) {
        for (const group of timePeriod.Groups) {
          const arn = group?.Keys?.[0];
          const amount = group?.Metrics?.UnblendedCost?.Amount;
          const unit = group?.Metrics?.UnblendedCost?.Unit ?? "USD";
          if (arn && amount !== undefined) {
            results.push({
              arn,
              actualMonthlyCost: `$${parseFloat(amount).toFixed(2)}/month`,
              forecastedMonthlyCost: `$${parseFloat(amount).toFixed(2)}/month`,
              currency: unit,
              lastUpdated: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  return results;
}

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
    } catch {
      // MCP unavailable — fall through to memory fallback
    }
  }

  // Fallback: provision log memory
  const provisions = await defaultMemoryService.readProvisions();
  for (const p of provisions) {
    if (p.resourceArn && p.estimatedMonthlyCost) {
      costMap.set(p.resourceArn, {
        arn: p.resourceArn,
        actualMonthlyCost: p.estimatedMonthlyCost,
        forecastedMonthlyCost: p.estimatedMonthlyCost,
        currency: "USD",
        lastUpdated: p.timestamp,
      });
    }
  }

  return costMap;
}

/**
 * Gets cost savings estimate for a specific resource.
 * Used by `assignee destroy` to show savings when removing a resource.
 *
 * @returns Formatted string like "$X.XX/month saved" or "N/A" on failure
 */
export async function getCostSavingsEstimate(
  arn: string,
  mcpTools?: StructuredTool[],
): Promise<string> {
  try {
    const dummyResource: ManagedResource = {
      resourceType: "unknown",
      arn,
      region: "us-east-1",
      createdDate: "N/A",
      estimatedMonthlyCost: "N/A",
    };

    const costMap = await fetchBillingData([dummyResource], mcpTools);
    const data = costMap.get(arn);
    if (data) {
      return `${data.actualMonthlyCost} saved`;
    }
  } catch {
    // Graceful degradation
  }

  return "N/A";
}
