/**
 * Pricing-registry-backed cost estimator for the estimate_cost MCP
 * tool. Delegates pricing lookup to the @assignee/core
 * PricingStrategyRegistry and merges the free-tier annotation on top.
 *
 * Does NOT run the full LangGraph pipeline and makes no AWS API
 * calls — cost numbers are still ultimately sourced from the
 * Pricing MCP upstream of the registry (no hardcoded dollar amounts).
 *
 * @see Story 20.4
 * @see feedback_no_hardcoded_prices
 */

import { defaultPricingRegistry, type PricingEstimate } from "@assignee/core";
import { getFreeTierNote } from "../free-tier.js";
import { formatEstimate } from "./formatter.js";
import type { CostEstimateResult } from "./types.js";

/**
 * Estimates the monthly cost for a resource type.
 *
 * @param resourceType - CloudFormation resource type (e.g. "AWS::S3::Bucket")
 * @param desiredState - Optional desired state for more accurate estimates
 * @returns Cost estimate result with free-tier annotation when applicable
 */
export function estimateCostForResource(
  resourceType: string,
  desiredState?: Record<string, unknown>,
): CostEstimateResult {
  const estimate: PricingEstimate = defaultPricingRegistry.estimate(
    resourceType,
    desiredState,
  );

  const result: CostEstimateResult = {
    resourceType,
    estimatedMonthlyCost: formatEstimate(estimate),
  };

  const freeTier = getFreeTierNote(resourceType);
  if (freeTier) {
    result.freeTierEligible = true;
    result.freeTierNote = freeTier.message;

    // If pricing is unavailable but the resource is free-tier
    // eligible, reflect that in the cost label so callers don't see
    // a bare "Pricing unavailable" message for a free resource.
    if (estimate.perMonth === null && estimate.isFree !== true) {
      result.estimatedMonthlyCost = "$0.00 (within free tier)";
    }
  }

  return result;
}
