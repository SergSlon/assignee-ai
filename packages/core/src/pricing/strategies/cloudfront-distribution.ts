import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::CloudFront::Distribution.
 *
 * Pricing model (all usage-dependent, none knowable from desiredState):
 *   - Data transfer out to public internet ($0.085/GB tiered by geo)
 *   - HTTPS requests ($0.01 per 10,000)
 *   - Cache invalidations (first 1,000 free, then $0.005 each)
 *   - Field-Level Encryption (optional, $0.02 per 10,000 requests)
 *   - Real-Time Logs (optional, $0.01 per 1,000,000 lines)
 *
 * estimateLocal returns N/A because the workload volume is not
 * knowable from desiredState. The decomposer surfaces the two
 * headline usage-based line items (data transfer + requests) so
 * users see the cost shape in the plan box.
 *
 * @see A14 (2026-04-09)
 */
export const cloudFrontDistributionPricingStrategy: PricingStrategy = {
  estimateLocal(_desiredState?: Record<string, unknown>): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
};
