/**
 * Shared types + parsing primitives for cost-optimizer analyzers.
 */

/** ~730 hours in an average calendar month — AWS monthly billing convention. */
export const HOURS_PER_MONTH = 730;

/** Confidence tier for a recommendation. */
export type OptimizationConfidence = "high" | "medium" | "low";

/** Structured rightsizing recommendation for a single managed resource. */
export interface CostOptRecommendation {
  /** Full AWS ARN of the managed resource. */
  resourceArn: string;
  /** CloudFormation-style resource type (AWS::EC2::Instance, etc.). */
  resourceType: string;
  /** Human-readable current configuration (e.g. "t3.large"). */
  currentConfig: string;
  /** Human-readable recommended configuration. */
  recommendedConfig: string;
  /** Current on-demand hourly rate as returned by the Pricing MCP (e.g. "$0.0832/hr"). */
  currentHourly: string;
  /** Recommended on-demand hourly rate. */
  recommendedHourly: string;
  /** Estimated monthly savings delta formatted for display (e.g. "$30.37/mo"). */
  monthlySavings: string;
  /** Savings as a percentage of the current monthly cost (e.g. 20 for 20%). */
  savingsPercent: number;
  /** Raw numeric delta, for sorting highest-first. */
  savingsAbsoluteUsd: number;
  /** Short rationale for display under the recommendation. */
  rationale: string;
  /** How confident the recommendation is — high for direct swaps, lower for heuristics. */
  confidence: OptimizationConfidence;
}

/**
 * Parse a pricing-MCP response string like `"$0.0832/hr"` into a
 * numeric USD-per-hour value. Returns `null` when the input does
 * not look like a price string — callers treat that as "no price
 * data available" and skip the recommendation.
 */
export function parseHourly(price: string | undefined): number | null {
  if (typeof price !== "string") return null;
  const match = price.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Build a recommendation from a live price pair. Returns `null`
 * when either price is missing, the recommended price is not
 * strictly cheaper, or the resulting savings round to zero.
 *
 * Exported for unit testing.
 */
export function buildRecommendation(params: {
  resourceArn: string;
  resourceType: string;
  currentConfig: string;
  recommendedConfig: string;
  currentHourlyRaw: string;
  recommendedHourlyRaw: string;
  rationale: string;
  confidence: OptimizationConfidence;
}): CostOptRecommendation | null {
  const currentRate = parseHourly(params.currentHourlyRaw);
  const recommendedRate = parseHourly(params.recommendedHourlyRaw);
  if (currentRate === null || recommendedRate === null) return null;
  if (recommendedRate >= currentRate) return null;

  const monthlyCurrent = currentRate * HOURS_PER_MONTH;
  const monthlyRecommended = recommendedRate * HOURS_PER_MONTH;
  const delta = monthlyCurrent - monthlyRecommended;
  if (delta < 0.01) return null; // Sub-cent savings aren't worth surfacing.

  const savingsPercent = Math.round((delta / monthlyCurrent) * 100);
  const monthlySavings = `$${delta.toFixed(2)}/mo`;

  return {
    resourceArn: params.resourceArn,
    resourceType: params.resourceType,
    currentConfig: params.currentConfig,
    recommendedConfig: params.recommendedConfig,
    currentHourly: params.currentHourlyRaw,
    recommendedHourly: params.recommendedHourlyRaw,
    monthlySavings,
    savingsPercent,
    savingsAbsoluteUsd: delta,
    rationale: params.rationale,
    confidence: params.confidence,
  };
}
