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

export const snsPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: null,
      label: "Per-publish pricing (per million)",
      source: "fallback",
    };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.SNS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.MESSAGE_DELIVERY,
          Type: M.TERM_MATCH,
        },
      ],
      unit: PriceUnit.PER_MILLION_PUBLISHES,
    };
  },
};
