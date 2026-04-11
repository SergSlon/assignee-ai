import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::EC2::Route.
 * Routes are free AWS resources — no associated costs.
 *
 * @see Story 40.4
 */
export const routePricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: null,
      label: CostEstimateLabel.NO_CHARGE,
      isFree: true,
      source: "free",
    };
  },
  // No mcpConfig — Routes are free AWS resources
};
