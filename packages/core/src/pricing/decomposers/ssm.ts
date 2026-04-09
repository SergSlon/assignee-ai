/**
 * SSM Parameter Pricing Decomposer — breaks an SSM parameter into billable
 * components based on tier.
 *
 * Standard tier parameters are free. Advanced tier parameters incur storage
 * and API call charges.
 */

import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
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

export const ssmPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.SSM_PARAMETER,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const tier = String(
      desiredState[CfnKey.TIER] ?? AwsDefault.SSM_TIER_STANDARD,
    ).toLowerCase();

    // Standard tier is free — no billable components
    if (tier === "standard") {
      return [];
    }

    const items: PricingLineItem[] = [];

    // 1. Parameter storage (per parameter per month)
    items.push({
      label: LineItemLabel.PARAMETER_STORAGE,
      quantity: 1,
      unit: PricingUnit.PARAMETER,
      serviceCode: SC.SSM,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.SYSTEMS_MANAGER,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.USAGE_TYPE,
          Value: "ParameterStorage-Advanced-Tier1",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.FIXED,
      description:
        "Advanced tier parameter storage (billed per param regardless of reads)",
      priceUnit: PriceUnit.PER_PARAM_MONTH,
    });

    // 2. API calls (higher throughput)
    items.push({
      label: LineItemLabel.API_CALLS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.SSM,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.SYSTEMS_MANAGER,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.USAGE_TYPE,
          Value: "PS-GetParameter-Transactions-Tier1",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description:
        "Advanced tier higher-throughput API calls (per 10k requests)",
      priceUnit: PriceUnit.PER_10K_REQS,
    });

    return items;
  },
};
