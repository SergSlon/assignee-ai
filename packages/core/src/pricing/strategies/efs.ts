import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";
import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";
import { PriceUnit } from "../price-units.js";

/**
 * EFS pricing strategy — surfaces the headline storage price per GB-month.
 * The richer line-item breakdown (Standard storage + optional Provisioned
 * throughput + optional Backup) is in decomposers/efs.ts.
 */
export const efsPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: null,
      label: "Per-GB monthly storage",
      source: "fallback",
    };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.EFS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.STORAGE,
          Type: M.TERM_MATCH,
        },
      ],
      unit: PriceUnit.PER_GB_MONTH_LONG,
    };
  },
};
