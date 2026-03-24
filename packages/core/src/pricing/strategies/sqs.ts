import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

export const sqsPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "Per-request pricing (standard queue)" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: "AmazonSQS",
      filters: [{ Field: "productFamily", Value: "Queue", Type: "TERM_MATCH" }],
      unit: "/million requests",
    };
  },
};
