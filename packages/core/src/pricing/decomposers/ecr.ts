/**
 * ECR Pricing Decomposer — breaks an ECR repository into billable components:
 * image storage.
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

export const ecrPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.ECR_REPOSITORY,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Storage (per GB-month)
    items.push({
      label: LineItemLabel.STORAGE,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.ECR,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.CONTAINER_REGISTRY,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "image storage",
      priceUnit: PriceUnit.PER_GB_MONTH,
    });

    return items;
  },
};
