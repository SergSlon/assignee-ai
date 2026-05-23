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
import { isPerUnitRate } from "../utils/per-unit-rate.js";

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
 *
 * F19: returns `null` for per-unit rate strings (e.g. `$0.0230/GB-month`)
 * so the caller can distinguish "variable, exclude from sum" from
 * "zero / unparseable".
 */
export function parseCost(costStr: string): number | null {
  if (!costStr || costStr === CostEstimateLabel.NA) return 0;
  if (isPerUnitRate(costStr)) return null;
  const match = costStr.match(/\$?([\d.]+)/);
  if (!match?.[1]) return 0;
  const value = parseFloat(match[1]);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Formats a numeric cost as "$X.XX/month".
 * Returns "N/A" for zero or negative values.
 *
 * F19: when `lowerBound` is true (any row was excluded for being a
 * per-unit rate), prefix the rendered value with "≥ " to signal
 * the displayed total is a floor, not the actual cost. Matches the
 * F6 (bulk-destroy) and F16 (admin list) wording for consistency.
 */
export function formatCost(cost: number, lowerBound = false): string {
  if (cost <= 0 && !lowerBound) return CostEstimateLabel.NA;
  const prefix = lowerBound ? "≥ " : "";
  return `${prefix}$${cost.toFixed(2)}/month`;
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

  // F19: track which buckets had at least one per-unit-rate row
  // (parseCost returned null) so the displayed totals can carry
  // the "≥" lower-bound prefix.
  const byTypeMap = new Map<
    string,
    { count: number; cost: number; lowerBound: boolean }
  >();
  const byRegionMap = new Map<
    string,
    { count: number; cost: number; lowerBound: boolean }
  >();
  let totalCost = 0;
  let totalLowerBound = false;

  for (const r of enrichedResources) {
    const parsed = parseCost(r.estimatedMonthlyCost);
    const cost = parsed ?? 0;
    const isVariable = parsed === null;
    if (isVariable) totalLowerBound = true;
    totalCost += cost;

    // Group by type
    const typeEntry = byTypeMap.get(r.resourceType) ?? {
      count: 0,
      cost: 0,
      lowerBound: false,
    };
    typeEntry.count += 1;
    typeEntry.cost += cost;
    typeEntry.lowerBound = typeEntry.lowerBound || isVariable;
    byTypeMap.set(r.resourceType, typeEntry);

    // Group by region
    const regionEntry = byRegionMap.get(r.region) ?? {
      count: 0,
      cost: 0,
      lowerBound: false,
    };
    regionEntry.count += 1;
    regionEntry.cost += cost;
    regionEntry.lowerBound = regionEntry.lowerBound || isVariable;
    byRegionMap.set(r.region, regionEntry);
  }

  return {
    totalResources: enrichedResources.length,
    totalEstimatedMonthlyCost: formatCost(totalCost, totalLowerBound),
    byType: [...byTypeMap.entries()]
      .map(([type, d]) => ({
        type,
        count: d.count,
        estimatedMonthlyCost: formatCost(d.cost, d.lowerBound),
      }))
      .sort((a, b) => b.count - a.count),
    byRegion: [...byRegionMap.entries()]
      .map(([region, d]) => ({
        region,
        count: d.count,
        estimatedMonthlyCost: formatCost(d.cost, d.lowerBound),
      }))
      .sort((a, b) => b.count - a.count),
    lastUpdated: new Date().toISOString(),
  };
}
