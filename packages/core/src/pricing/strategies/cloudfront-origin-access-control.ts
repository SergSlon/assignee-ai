import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::CloudFront::OriginAccessControl.
 *
 * OAC has no per-resource meter. The SigV4 signing work happens on
 * CloudFront's edge nodes, and those are already billed at the
 * parent distribution level (per-request + data transfer out). The
 * subscription is pure wiring — returning N/A keeps the plan-box
 * honest without double-counting what the distribution strategy is
 * already showing.
 *
 * @see (f) 2026-04-09 Task 4b
 */
export const cloudFrontOacPricingStrategy: PricingStrategy = {
  estimateLocal(_desiredState?: Record<string, unknown>): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA };
  },
};
