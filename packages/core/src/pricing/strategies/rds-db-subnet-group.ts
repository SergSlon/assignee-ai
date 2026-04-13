import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::RDS::DBSubnetGroup.
 *
 * DB subnet groups are pure wiring — they tell RDS which VPC subnets
 * the DB instance may use for its ENIs. There is no per-group charge;
 * the RDS instance itself carries the compute + storage bill.
 * Returning N/A keeps the plan-box honest.
 *
 * @see 2026-04-13
 */
export const rdsDbSubnetGroupPricingStrategy: PricingStrategy = {
  estimateLocal(_desiredState?: Record<string, unknown>): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
};
