import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

export const ecrPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "Per-GB monthly storage" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: "AmazonECR",
      filters: [
        {
          Field: "productFamily",
          Value: "EC2 Container Registry",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/GB-month",
    };
  },
};
