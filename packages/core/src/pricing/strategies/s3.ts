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
  CostEstimateLabel,
} from "../filter-constants.js";
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PriceUnit } from "../price-units.js";

export const s3PricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.STORAGE, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: FV.TIMED_STORAGE_BYTE_HRS,
          Type: M.TERM_MATCH,
        },
      ],
      unit: PriceUnit.PER_GB_MONTH_LONG,
    };
  },
};
