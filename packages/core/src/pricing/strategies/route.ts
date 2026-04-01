import type { PricingStrategy, PricingEstimate } from "../types.js";

/**
 * Pricing strategy for AWS::EC2::Route.
 * Routes are free AWS resources — no associated costs.
 *
 * @see Story 40.4
 */
export const routePricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "No charge", isFree: true };
  },
  // No mcpConfig — Routes are free AWS resources
};
