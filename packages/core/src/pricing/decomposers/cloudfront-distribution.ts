/**
 * CloudFront::Distribution pricing decomposer.
 *
 * Surfaces the two headline usage-based line items so the plan
 * box shows the cost shape at plan time:
 *   1. Data transfer out ($0.085/GB tier 1 in the NA edge group)
 *   2. HTTPS requests ($0.000001/req — equivalent to $0.01 per 10K)
 *
 * Both are USAGE_BASED with quantity=0 — workload volume is
 * not knowable from the DistributionConfig. Cache invalidations,
 * Field-Level Encryption, and Real-Time Logs are deferred because
 * they're optional and config-dependent; the advisor surfaces
 * them as awareness-only guidance if the user enables them.
 *
 * F6-ITEM-2 amendment (Quinn HIGH-1 / HIGH-2):
 *
 *   - Data transfer line gains a `fromLocation = "North America"`
 *     filter. The Pricing API publishes a separate tier ladder per
 *     edge region; without the filter `extractTieredPrice` picks
 *     whichever entry the MCP server returns first → non-
 *     deterministic $/mo across runs. We pin to NA because every
 *     Assignee hardcoded pattern (static-website / spa-website /
 *     static-site) uses `PriceClass_100`, which routes through
 *     US/EU/Israel edges only and matches the NA tier 1 rate.
 *     PriceClass-aware per-edge selection is tracked as F6-followup.
 *
 *   - Requests line `priceUnit` changed from `/10K reqs` to `/req`.
 *     The AWS rate IS per-request ($0.000001/req); the prior label
 *     claimed per-10K which is off by 4 orders of magnitude in
 *     implied meaning. Other decomposers (KMS / SSM / SecretsManager)
 *     have the same pre-existing defect; tracked in
 *     `_backlog/per-10k-reqs-display-bug-other-services.md`.
 *
 * @see A14 (2026-04-09)
 * @see _backlog/wizard-ux-audit-2026-05-22.md F6
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";
import {
  PricingField as F,
  PricingKind as K,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PriceUnit } from "../price-units.js";
import { LineItemLabel } from "../line-item-labels.js";
import { PricingUnit } from "../units.js";

export const cloudFrontDistributionPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    return [
      {
        label: LineItemLabel.DATA_TRANSFER_OUT,
        quantity: 0,
        unit: PricingUnit.GB,
        serviceCode: SC.CLOUDFRONT,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.DATA_TRANSFER,
            Type: M.TERM_MATCH,
          },
          {
            Field: F.FROM_LOCATION,
            Value: FV.FROM_LOCATION_NORTH_AMERICA,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "Data transfer out to public internet (NA edge)",
        priceUnit: PriceUnit.PER_GB,
      },
      {
        label: LineItemLabel.REQUESTS,
        quantity: 0,
        unit: PricingUnit.REQUESTS,
        serviceCode: SC.CLOUDFRONT,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.API_REQUEST,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "HTTPS requests",
        priceUnit: PriceUnit.PER_REQ,
      },
    ];
  },
};
