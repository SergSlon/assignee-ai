/**
 * Query spec type and registry for the advisory price enricher.
 *
 * Registry is a `Partial<Record<AdvisoryPriceId, AdvisoryPriceQuery>>` so
 * we can narrow the enrichable set without touching the enum — every
 * verified query lands here; unverified IDs fall back to the formatted
 * constant tagged "(estimated)".
 *
 * Scope discipline: only verified queries ship here. See the original
 * file header for the 4 IDs intentionally left unenriched.
 *
 * feedback_no_hardcoded_prices.md: the fallback values are the existing
 * *_APPROX constants from `pricing/advisory-prices.ts`. Registry
 * additions must route through the Pricing MCP — do NOT bake new dollar
 * amounts into this file.
 *
 * Lifted from apps/cli/src/services/advisory-price-enricher/types.ts in
 * Story 50-4 Wave 5 Pass G so the in-core advice-generator node can
 * use the enricher without reaching back into the CLI app.
 *
 * @see Story 46.3
 */

import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
  PricingFilterValue as FV,
  type McpPricingFilter,
} from "../../pricing/index.js";
import { HOURS_PER_MONTH } from "../../config/constants/limits.js";
import {
  AdvisoryPriceId,
  NAT_GATEWAY_MONTHLY_APPROX,
  ALB_MONTHLY_APPROX,
  CW_ALARM_PER_MONTH,
} from "../../pricing/advisory-prices.js";

/**
 * Internal spec for one enrichable advisory price. Adding a new ID
 * requires:
 *   1. Add an enum entry in `pricing/advisory-prices.ts`
 *   2. Add a query spec here AND verify the filter set produces the
 *      right `extractFirstTierPrice` row against a captured response
 *   3. Reference `enriched.get(id).label` in the relevant hint
 */
export interface AdvisoryPriceQuery {
  /** AWS Pricing API service code (e.g. AmazonEC2). */
  serviceCode: string;
  /** Filters that uniquely select the rate row in the response. */
  filters: McpPricingFilter[];
  /** Display unit string forwarded to extractFirstTierPrice. */
  unit: string;
  /** `extractFirstTierPrice` scale multiplier (default 1). */
  scale?: number;
  /** Hand-coded fallback used when the MCP path fails. */
  fallbackValue: number;
  /**
   * Convert the raw extracted hourly/per-unit rate into the value the
   * hint surfaces. Most queries return /hour and we want /month, so
   * `convert: (h) => h * HOURS_PER_MONTH` is common. The default is
   * identity (the raw rate IS the displayable value, e.g. $0.50/GB).
   */
  convert?: (raw: number) => number;
  /**
   * Format `value` into the bare label *without* the provenance suffix.
   * The enricher then runs the result through `formatLabelWithSource`
   * to append `(live)` / `(estimated)`.
   */
  format: (value: number) => string;
}

/**
 * Enrichable advisory price registry. Only verified queries — see the
 * "Scope discipline" comment in the original enricher file. IDs not
 * present here have intentionally absent map entries; the cost-advisor
 * helper falls back to the formatted constant tagged "(estimated)".
 */
export const ADVISORY_PRICE_QUERIES: Partial<
  Record<AdvisoryPriceId, AdvisoryPriceQuery>
> = {
  [AdvisoryPriceId.NAT_GATEWAY_MONTHLY]: {
    serviceCode: SC.EC2,
    filters: [
      { Field: F.PRODUCT_FAMILY, Value: PF.NAT_GATEWAY, Type: M.TERM_MATCH },
      {
        Field: F.USAGE_TYPE,
        Value: FV.NAT_GATEWAY_HOURS,
        Type: M.TERM_MATCH,
      },
    ],
    unit: "/hour",
    fallbackValue: NAT_GATEWAY_MONTHLY_APPROX,
    convert: (hourly) => hourly * HOURS_PER_MONTH,
    format: (monthly) => `~$${monthly.toFixed(2)}/mo`,
  },
  [AdvisoryPriceId.ALB_MONTHLY]: {
    serviceCode: SC.ELB,
    filters: [
      { Field: F.PRODUCT_FAMILY, Value: PF.LOAD_BALANCER, Type: M.TERM_MATCH },
    ],
    unit: "/hour",
    fallbackValue: ALB_MONTHLY_APPROX,
    convert: (hourly) => hourly * HOURS_PER_MONTH,
    format: (monthly) => `~$${monthly.toFixed(2)}/mo`,
  },
  [AdvisoryPriceId.CW_ALARM_PER_MONTH]: {
    serviceCode: SC.CLOUDWATCH,
    filters: [{ Field: F.PRODUCT_FAMILY, Value: PF.ALARM, Type: M.TERM_MATCH }],
    unit: "/alarm-month",
    fallbackValue: CW_ALARM_PER_MONTH,
    format: (rate) => `$${rate.toFixed(2)}/alarm/month`,
  },
};

/**
 * Snapshot of which AdvisoryPriceIds are currently enrichable. Derived
 * from the queries record so adding a new entry above automatically
 * extends iteration. Exposed read-only for the parametrized test suite.
 */
export const ENRICHABLE_PRICE_IDS: readonly AdvisoryPriceId[] = Object.freeze(
  Object.keys(ADVISORY_PRICE_QUERIES) as AdvisoryPriceId[],
);

/** Per-query budget — matches the existing advice-generator parallel block. */
export const ENRICHMENT_TIMEOUT_MS = 3000;
