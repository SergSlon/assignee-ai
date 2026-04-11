import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::Events::ApiDestination.
 *
 * Pricing model:
 *   - $0.20 per 1,000,000 ApiDestination invocations.
 *   - Invocation count is workload-dependent (depends on how many
 *     events the referenced Rule matches per month), so estimateLocal
 *     returns N/A — the decomposer surfaces the usage-based line
 *     item and the cost-advisor will annotate it with a workload
 *     reminder.
 *
 * @see A13 (2026-04-09)
 */
export const eventsApiDestinationPricingStrategy: PricingStrategy = {
  estimateLocal(_desiredState?: Record<string, unknown>): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
};
