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
 * @see Epic 92 Wave 4 (e92.4.a) — savings formatter sanitation
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
 * Epic 92 Wave 4 (e92.4.a) — display-only zero tokens for free / unavailable
 * savings lines. These are NOT price lookups: `FREE_SAVINGS_DISPLAY` renders
 * a zero-sentinel for resources the pricing layer has already marked as
 * `CostEstimateLabel.FREE` / `CostEstimateLabel.NO_CHARGE`, and
 * `NO_SAVINGS_DISPLAY` is the noun-phrase used when the MCP returned no
 * parseable dollar amount. Zero hardcoded prices — the `$0.00` literal
 * below is a display string, never a rate lookup.
 */
const FREE_SAVINGS_DISPLAY = "Free, $0.00 savings" as const;
const NO_SAVINGS_DISPLAY = "No cost savings" as const;

/**
 * Heuristic: does this string look like a parseable dollar amount?
 *
 * Covers the happy-path MCP formats:
 *   - `$0.02/month`
 *   - `$3.00/mo`
 *   - `~$32.85/mo`
 *   - `$99.99/mo`
 *
 * Rejects non-numeric labels:
 *   - `"Free"`, `"No charge"`, `"N/A"`
 *   - `"Per-request pricing (standard queue)"`
 *   - `"Per-request pricing (FIFO queue)"`
 *   - `"Per-GB pricing"`
 */
function isParseableDollarAmount(s: string): boolean {
  return /\$\d/.test(s);
}

/**
 * Epic 92 Wave 4 (e92.4.a) — render the savings suffix safely.
 * Closes A-08 / B-21 / D-15 / D-18.
 *
 * Three buckets:
 *   1. Parseable dollar amount (matches `$N`)    → `"{cost} saved"`.
 *   2. Free / No charge (pricing-layer sentinels) → `"Free, $0.00 savings"`.
 *   3. Anything else (N/A, per-request pricing…)  → `"No cost savings"`.
 *
 * Exported for direct testing; also consumed by the destroy-side
 * formatter in `apps/cli/src/commands/destroy/result-formatter.ts`
 * (which receives the already-formatted string via
 * `getCostSavingsEstimate`).
 */
export function formatSavingsDisplay(actualMonthlyCost: string): string {
  if (isParseableDollarAmount(actualMonthlyCost)) {
    return `${actualMonthlyCost} saved`;
  }
  if (
    actualMonthlyCost === CostEstimateLabel.FREE ||
    actualMonthlyCost === CostEstimateLabel.NO_CHARGE
  ) {
    return FREE_SAVINGS_DISPLAY;
  }
  return NO_SAVINGS_DISPLAY;
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
 * Epic 92 Wave 4 (e92.4.a) — sanitized output:
 *   - parseable dollar amount (`$0.02/month`) → `"$0.02/month saved"`
 *   - `CostEstimateLabel.FREE` / `CostEstimateLabel.NO_CHARGE` →
 *     `"Free, $0.00 savings"` (closes B-21 + D-18)
 *   - anything else (incl. `CostEstimateLabel.NA`,
 *     `"Per-request pricing (standard queue)"`, `"Per-GB pricing"`) →
 *     `"No cost savings"` (closes A-08 + D-15)
 *   - MCP + provision-log both empty → `"No cost savings"`
 *
 * @returns Formatted string. Never throws.
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
      return formatSavingsDisplay(data.actualMonthlyCost);
    }
  } catch (err) {
    logBillingMcpFailure("getCostSavingsEstimate", err);
    // Graceful degradation
  }

  return NO_SAVINGS_DISPLAY;
}
