import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::SNS::Subscription.
 *
 * Subscriptions themselves have no per-subscription charge. The
 * costs are entirely owned by:
 *
 *   - the SNS topic (per-million-publish fees + delivery fees by
 *     protocol — see sns-topic pricing strategy), and
 *   - the target service (SQS queue receives, Lambda invocations,
 *     Firehose delivery records, HTTPS data-out, etc.).
 *
 * Returning N/A here keeps the per-month display honest: the
 * subscription is the wiring, not the meter. The parent SNS::Topic
 * decomposer continues to surface the publish-side fees.
 *
 * @see A10 (2026-04-09)
 */
export const snsSubscriptionPricingStrategy: PricingStrategy = {
  estimateLocal(_desiredState?: Record<string, unknown>): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
};
