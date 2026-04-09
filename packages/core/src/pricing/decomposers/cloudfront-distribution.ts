/**
 * CloudFront::Distribution pricing decomposer.
 *
 * Surfaces the two headline usage-based line items so the plan
 * box shows the cost shape at plan time:
 *   1. Data transfer out ($0.085/GB tier in us-east-1)
 *   2. HTTPS requests ($0.01 per 10k)
 *
 * Both are USAGE_BASED with quantity=0 — workload volume is
 * not knowable from the DistributionConfig. Cache invalidations,
 * Field-Level Encryption, and Real-Time Logs are deferred because
 * they're optional and config-dependent; the advisor surfaces
 * them as awareness-only guidance if the user enables them.
 *
 * @see A14 (2026-04-09)
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
        ],
        kind: K.USAGE_BASED,
        description: "Data transfer out to public internet",
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
        priceUnit: PriceUnit.PER_10K_REQS,
      },
    ];
  },
};
