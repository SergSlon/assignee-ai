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

export const ecrPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: null,
      label: "Per-GB monthly storage",
      source: "fallback",
    };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.ECR,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.CONTAINER_REGISTRY,
          Type: M.TERM_MATCH,
        },
      ],
      unit: PriceUnit.PER_GB_MONTH_LONG,
    };
  },
};
