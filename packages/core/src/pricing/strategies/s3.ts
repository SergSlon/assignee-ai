import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

export const s3PricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "N/A" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: "AmazonS3",
      filters: [
        { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
        {
          Field: "usagetype",
          Value: "TimedStorage-ByteHrs",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/GB-month",
    };
  },
};
