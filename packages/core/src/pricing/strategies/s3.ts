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

export const s3PricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "N/A" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.STORAGE, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: "TimedStorage-ByteHrs",
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/GB-month",
    };
  },
};
