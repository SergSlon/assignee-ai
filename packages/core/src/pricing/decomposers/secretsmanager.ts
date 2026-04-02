/**
 * Secrets Manager Pricing Decomposer — breaks a secret into billable components:
 * secret storage (fixed per secret) and API calls (usage-based).
 *
 * @see Story 23.3
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

export const secretsManagerPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Secret storage
    items.push({
      label: LineItemLabel.SECRET_STORAGE,
      quantity: 1,
      unit: PricingUnit.SECRET,
      serviceCode: SC.SECRETS_MANAGER,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.SECRET, Type: M.TERM_MATCH },
      ],
      kind: K.FIXED,
      description: "1 secret",
      priceUnit: PriceUnit.PER_SECRET_MONTH,
    });

    // 2. API calls
    items.push({
      label: LineItemLabel.API_CALLS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.SECRETS_MANAGER,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_REQUEST, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: "per 10,000 API calls",
      priceUnit: PriceUnit.PER_10K_REQS,
    });

    return items;
  },
};
