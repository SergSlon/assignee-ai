import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

export const snsPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "Per-publish pricing (per million)" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: "AmazonSNS",
      filters: [
        {
          Field: "productFamily",
          Value: "Message Delivery",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/million publishes",
    };
  },
};
