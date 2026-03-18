import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

export const ssmPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "N/A" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: "AWSSystemsManager",
      filters: [
        {
          Field: "productFamily",
          Value: "AWS Systems Manager",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/param-hour",
    };
  },
};
