/**
 * Shared types for the cost-estimator subsystem.
 *
 * @see Story 20.4
 */

/** Result shape for the estimate_cost tool. */
export interface CostEstimateResult {
  resourceType: string;
  estimatedMonthlyCost: string;
  freeTierEligible?: boolean;
  freeTierNote?: string;
}

/** A single keyword → resource-type row used by the classifier. */
export interface KeywordEntry {
  keywords: string[];
  resourceType: string;
}
