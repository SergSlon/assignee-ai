/**
 * Billing MCP cost-explorer client — queries the AWS Cost Explorer tool via
 * the Billing MCP server, groups by SERVICE dimension, and distributes
 * service-level costs across resources of the same service type.
 *
 * Note: RESOURCE_ID grouping is only available via
 * getCostAndUsageWithResources (limited to last 14 days). SERVICE grouping
 * gives reliable monthly data.
 *
 * PRESERVES zero-bare-catch invariant — all errors route through
 * logBillingMcpFailure.
 *
 * Extracted from billing.ts during Wave-6c decomposition.
 *
 * @see Story 19.7
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../../constants/tools.js";
import type { ManagedResource } from "../list-resources.js";
import {
  ARN_SERVICE_TO_CE_SERVICE,
  arnToServiceSlug,
} from "./arn-service-map.js";
import { currentMonthRange } from "./date-range.js";
import { logBillingMcpFailure } from "./error-handler.js";
import { extractResultsByTime } from "./parser.js";
import type { BillingCostData } from "./types.js";

/**
 * Queries the Billing MCP server's cost-explorer tool for service-level costs.
 * Groups by SERVICE dimension (RESOURCE_ID requires getCostAndUsageWithResources
 * which is limited to 14 days). Distributes service costs across resources of
 * that service type.
 *
 * Returns an array of BillingCostData entries. Returns empty array on any error.
 */
export async function queryBillingMcp(
  resources: ManagedResource[],
  mcpTools: StructuredTool[],
): Promise<BillingCostData[]> {
  const costTool = mcpTools.find((t) => t.name === ToolName.COST_EXPLORER);
  if (!costTool) return [];

  const { start, end } = currentMonthRange();

  // Collect unique service names from the resource ARNs
  const serviceNames = new Set<string>();
  for (const r of resources) {
    const slug = arnToServiceSlug(r.arn);
    const ceName = slug ? ARN_SERVICE_TO_CE_SERVICE[slug] : undefined;
    if (ceName) serviceNames.add(ceName);
  }

  try {
    const response = await costTool.invoke({
      operation: "getCostAndUsage",
      start_date: start,
      end_date: end,
      granularity: "MONTHLY",
      metrics: JSON.stringify(["UnblendedCost"]),
      group_by: JSON.stringify([{ Type: "DIMENSION", Key: "SERVICE" }]),
      filter:
        serviceNames.size > 0
          ? JSON.stringify({
              Dimensions: {
                Key: "SERVICE",
                Values: [...serviceNames],
              },
            })
          : undefined,
    });

    const resultsByTime = extractResultsByTime(response);
    const serviceCosts = aggregateServiceCosts(resultsByTime);
    return distributeCostsAcrossResources(resources, serviceCosts);
  } catch (err) {
    // Graceful degradation: billing is non-blocking — return empty on any error.
    // Surface the reason under --verbose so operators can diagnose silent N/A.
    logBillingMcpFailure("queryBillingMcp.getCostAndUsage", err);
    return [];
  }
}

/** Build a map of CE service name -> total cost from the MCP response. */
function aggregateServiceCosts(
  resultsByTime: unknown[],
): Map<string, { amount: number; unit: string }> {
  const serviceCosts = new Map<string, { amount: number; unit: string }>();

  for (const timePeriod of resultsByTime as Array<{
    Groups?: Array<{
      Keys?: string[];
      Metrics?: Record<string, { Amount?: string; Unit?: string }>;
    }>;
  }>) {
    if (!timePeriod?.Groups) continue;
    for (const group of timePeriod.Groups) {
      const serviceName = group?.Keys?.[0];
      const ubCost = group?.Metrics?.["UnblendedCost"] as
        | { Amount?: string; Unit?: string }
        | undefined;
      const amount = ubCost?.Amount;
      const unit = ubCost?.Unit ?? "USD";
      if (serviceName && amount !== undefined) {
        const parsed = parseFloat(amount);
        if (Number.isNaN(parsed)) continue;
        const existing = serviceCosts.get(serviceName);
        const newAmount = parsed + (existing?.amount ?? 0);
        serviceCosts.set(serviceName, { amount: newAmount, unit });
      }
    }
  }

  return serviceCosts;
}

/**
 * Distribute service-level totals evenly across the resources belonging to
 * that service. Cost Explorer SERVICE grouping cannot give per-resource
 * cost, so an even split is the best we can do without the 14-day
 * getCostAndUsageWithResources API.
 */
function distributeCostsAcrossResources(
  resources: ManagedResource[],
  serviceCosts: Map<string, { amount: number; unit: string }>,
): BillingCostData[] {
  const results: BillingCostData[] = [];

  // Group resources by their CE service name
  const resourcesByService = new Map<string, ManagedResource[]>();
  for (const r of resources) {
    const slug = arnToServiceSlug(r.arn);
    const ceName = slug ? ARN_SERVICE_TO_CE_SERVICE[slug] : undefined;
    if (ceName) {
      const list = resourcesByService.get(ceName) ?? [];
      list.push(r);
      resourcesByService.set(ceName, list);
    }
  }

  const lastUpdated = new Date().toISOString();
  for (const [serviceName, serviceResources] of resourcesByService) {
    const cost = serviceCosts.get(serviceName);
    if (!cost) continue;

    const perResourceCost = cost.amount / serviceResources.length;
    for (const r of serviceResources) {
      results.push({
        arn: r.arn,
        actualMonthlyCost: `$${perResourceCost.toFixed(2)}/month`,
        forecastedMonthlyCost: `$${perResourceCost.toFixed(2)}/month`,
        currency: cost.unit,
        lastUpdated,
        // Story 46.2: live cost-explorer response
        source: "mcp",
      });
    }
  }

  return results;
}
