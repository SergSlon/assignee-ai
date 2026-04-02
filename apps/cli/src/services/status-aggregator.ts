/**
 * Status aggregator service — builds summary data from managed resources.
 *
 * Groups resources by type and region, enriches with cost data from the
 * Billing MCP server (Story 19.7, when available) with fallback to the
 * provision log memory (Story 19.3).
 *
 * @see Story 19.6
 */

import type { ManagedResource } from "./list-resources.js";
import { defaultMemoryService, type MemoryService } from "./memory.js";
import { CostEstimateLabel } from "@assignee/core";

export interface StatusByType {
  type: string;
  count: number;
  estimatedMonthlyCost: string;
}

export interface StatusByRegion {
  region: string;
  count: number;
  estimatedMonthlyCost: string;
}

export interface StatusData {
  totalResources: number;
  totalEstimatedMonthlyCost: string;
  byType: StatusByType[];
  byRegion: StatusByRegion[];
  lastUpdated: string;
}

/**
 * Parses a cost string like "$1.23/month", "$1.23", or "N/A" into a number.
 * Returns 0 for unparseable strings.
 */
export function parseCost(costStr: string): number {
  if (!costStr || costStr === CostEstimateLabel.NA) return 0;
  const match = costStr.match(/\$?([\d.]+)/);
  if (!match?.[1]) return 0;
  const value = parseFloat(match[1]);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Formats a numeric cost as "$X.XX/month".
 * Returns "N/A" for zero or negative values.
 */
export function formatCost(cost: number): string {
  if (cost <= 0) return CostEstimateLabel.NA;
  return `$${cost.toFixed(2)}/month`;
}

/**
 * Enriches resources with cost data from the Billing MCP server (Story 19.7)
 * with fallback to provision log memory.
 *
 * Cost priority: Billing MCP (live) > provision log (historical) > existing value.
 * The Billing MCP integration is not yet available; this function currently
 * uses the provision log fallback only.
 */
export async function enrichWithBillingData(
  resources: ManagedResource[],
  memoryService: MemoryService = defaultMemoryService,
): Promise<ManagedResource[]> {
  // Story 19.7: Billing MCP integration exists in billing.ts (fetchBillingData)
  // but requires MCP tools parameter. This function uses provision log fallback
  // only; callers needing live billing data should use fetchBillingData directly.

  let provisions: Awaited<ReturnType<MemoryService["readProvisions"]>>;
  try {
    provisions = await memoryService.readProvisions();
  } catch {
    // Memory service unavailable — return resources as-is
    return resources;
  }

  if (provisions.length === 0) return resources;

  const costMap = new Map<string, string>();
  for (const p of provisions) {
    if (p.resourceArn && p.estimatedMonthlyCost) {
      costMap.set(p.resourceArn, p.estimatedMonthlyCost);
    }
  }

  return resources.map((r) => {
    const memoryCost = costMap.get(r.arn);
    if (
      memoryCost &&
      (r.estimatedMonthlyCost === CostEstimateLabel.NA ||
        !r.estimatedMonthlyCost)
    ) {
      return { ...r, estimatedMonthlyCost: memoryCost };
    }
    return r;
  });
}

/**
 * Builds aggregated status data from a list of managed resources.
 * Groups by type and region, computes cost totals.
 */
export async function buildStatusData(
  resources: ManagedResource[],
  memoryService: MemoryService = defaultMemoryService,
): Promise<StatusData> {
  const enrichedResources = await enrichWithBillingData(
    resources,
    memoryService,
  );

  const byTypeMap = new Map<string, { count: number; cost: number }>();
  const byRegionMap = new Map<string, { count: number; cost: number }>();
  let totalCost = 0;

  for (const r of enrichedResources) {
    const cost = parseCost(r.estimatedMonthlyCost);
    totalCost += cost;

    // Group by type
    const typeEntry = byTypeMap.get(r.resourceType) ?? { count: 0, cost: 0 };
    typeEntry.count += 1;
    typeEntry.cost += cost;
    byTypeMap.set(r.resourceType, typeEntry);

    // Group by region
    const regionEntry = byRegionMap.get(r.region) ?? { count: 0, cost: 0 };
    regionEntry.count += 1;
    regionEntry.cost += cost;
    byRegionMap.set(r.region, regionEntry);
  }

  return {
    totalResources: enrichedResources.length,
    totalEstimatedMonthlyCost: formatCost(totalCost),
    byType: [...byTypeMap.entries()]
      .map(([type, d]) => ({
        type,
        count: d.count,
        estimatedMonthlyCost: formatCost(d.cost),
      }))
      .sort((a, b) => b.count - a.count),
    byRegion: [...byRegionMap.entries()]
      .map(([region, d]) => ({
        region,
        count: d.count,
        estimatedMonthlyCost: formatCost(d.cost),
      }))
      .sort((a, b) => b.count - a.count),
    lastUpdated: new Date().toISOString(),
  };
}
