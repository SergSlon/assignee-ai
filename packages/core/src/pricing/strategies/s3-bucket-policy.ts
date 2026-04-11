import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::S3::BucketPolicy.
 *
 * Bucket policies are an attribute of the underlying S3 bucket, not
 * a billable resource. The bucket itself is billed (storage,
 * requests, transfer) via the s3 pricing strategy. Returning N/A
 * keeps the plan-box honest.
 *
 * @see (f) 2026-04-09 Task 4b
 */
export const s3BucketPolicyPricingStrategy: PricingStrategy = {
  estimateLocal(_desiredState?: Record<string, unknown>): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
};
