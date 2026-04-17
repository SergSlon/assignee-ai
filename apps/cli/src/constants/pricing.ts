/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/constants/pricing-api` (Story 50-4 Wave 5 Pass C-2).
 *
 * Also re-exports deprecated aliases (PricingDefault, CostEstimate) for
 * backward compatibility during migration.
 */

export {
  PricingServiceCode,
  PricingFilter,
  PricingTerm,
  PricingUnit,
  PricingScale,
  LambdaPricing,
} from "@assignee/core";

/**
 * @deprecated Use AwsDefault from @assignee/core instead.
 * Re-exported for backward compatibility during migration.
 */
export { AwsDefault as PricingDefault } from "@assignee/core";

/**
 * @deprecated Use CostEstimateLabel from @assignee/core instead.
 * Re-exported for backward compatibility during migration.
 */
export { CostEstimateLabel as CostEstimate } from "@assignee/core";
