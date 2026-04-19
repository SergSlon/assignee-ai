/**
 * Headline cost resolution — combines the single-line headline with the
 * decomposer breakdown to produce the final display value + source.
 *
 * Rules (preserved verbatim):
 * 1. If headline is "N/A" but the breakdown has a positive fixedSubtotal,
 *    use the subtotal as the headline (source derived from breakdown).
 * 2. Else if headline is "N/A" but the breakdown has usage-based items
 *    with a priced first entry (and no partial failure), use that.
 * 3. Else if the decomposer fired but explicitly returned zero line items,
 *    the resource is free — headline becomes "Free", source "free".
 */
import {
  CostEstimateLabel,
  type DataSource,
  type PricingBreakdown,
} from "@/index.js";

export interface ResolveInput {
  headlineLabel: string;
  headlineSource: DataSource;
  breakdown?: PricingBreakdown;
  decomposerReportedFree: boolean;
}

export interface ResolveOutput {
  label: string;
  source: DataSource;
}

const breakdownSource = (b: PricingBreakdown): DataSource =>
  b.hasCacheHits ? "cached" : "mcp";

export function resolveHeadline(input: ResolveInput): ResolveOutput {
  let label = input.headlineLabel;
  let source: DataSource = input.headlineSource;
  const { breakdown, decomposerReportedFree } = input;

  if (
    label === CostEstimateLabel.NA &&
    breakdown &&
    breakdown.fixedSubtotal > 0
  ) {
    label = `$${breakdown.fixedSubtotal.toFixed(2)}/mo`;
    source = breakdownSource(breakdown);
  }

  if (
    label === CostEstimateLabel.NA &&
    breakdown &&
    !breakdown.hasPartialFailure &&
    breakdown.usageBasedItems.length > 0
  ) {
    const firstPriced = breakdown.usageBasedItems.find(
      (item) => item.unitPrice !== null,
    );
    if (firstPriced) {
      label = firstPriced.displayPrice;
      source = breakdownSource(breakdown);
    }
  }

  if (label === CostEstimateLabel.NA && decomposerReportedFree) {
    label = CostEstimateLabel.FREE;
    source = "free";
  }

  return { label, source };
}
