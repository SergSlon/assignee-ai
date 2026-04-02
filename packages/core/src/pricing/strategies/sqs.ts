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

export const sqsPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "Per-request pricing (standard queue)" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.SQS,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.QUEUE, Type: M.TERM_MATCH },
      ],
      unit: "/million requests",
    };
  },
};
