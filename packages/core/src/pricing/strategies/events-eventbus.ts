import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::Events::EventBus.
 *
 * Custom event buses bill $1.00 per million events PUBLISHED to
 * the bus. The per-event rate is fixed; what's not knowable from
 * the desiredState is the publish volume — that's a workload fact,
 * not a property of the bus itself.
 *
 * The strategy returns N/A locally (no perMonth value) because we
 * cannot honestly estimate "X $/month" without knowing the rate of
 * events. The cost-advisor will surface this in the plan box as
 * a workload-dependent line item.
 *
 * Note: Rule evaluation + target invocation costs are NOT billed
 * by the bus — they're billed by the rule + target services
 * respectively. So a single low-volume bus with high-volume
 * targets bills almost entirely on the target side.
 */
export const eventsEventBusPricingStrategy: PricingStrategy = {
  estimateLocal(_desiredState?: Record<string, unknown>): PricingEstimate {
    // Always N/A — workload-dependent. The cost-advisor surfaces
    // a $1/M warning for visibility.
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
};
