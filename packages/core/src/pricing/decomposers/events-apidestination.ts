/**
 * Events::ApiDestination pricing decomposer — usage-based
 * $0.20 per 1M invocations. Volume is workload-dependent (tied to
 * how many events the referenced Rule matches per month), so the
 * line item is emitted as USAGE_BASED with a quantity of 0 and the
 * cost-advisor will annotate it with a workload reminder at plan
 * time.
 *
 * @see A13 (2026-04-09)
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

export const eventsApiDestinationPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.EVENTS_API_DESTINATION,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    return [
      {
        label: LineItemLabel.API_CALLS,
        quantity: 0,
        unit: PricingUnit.REQUESTS,
        serviceCode: SC.EVENTS,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.API_REQUEST,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "per 1,000,000 ApiDestination invocations",
        priceUnit: PriceUnit.PER_MILLION_REQS,
      },
    ];
  },
};
