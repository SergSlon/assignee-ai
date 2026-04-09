import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::Events::Connection.
 *
 * Connections are FREE. The billable cost of the outbound
 * integration lives on the ApiDestination (per-invocation fee) and
 * on the target service if any. The managed Secrets Manager secret
 * that Connection creates on your behalf is bundled into the
 * Connection lifecycle and not separately billed.
 *
 * @see A12 (2026-04-09)
 */
export const eventsConnectionPricingStrategy: PricingStrategy = {
  estimateLocal(_desiredState?: Record<string, unknown>): PricingEstimate {
    return { perMonth: 0, label: CostEstimateLabel.FREE };
  },
};
