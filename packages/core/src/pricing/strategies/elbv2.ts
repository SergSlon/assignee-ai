import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

export const elbv2PricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "Hourly rate + LCU-based charges" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: "ElasticLoadBalancing",
      filters: [
        {
          Field: "productFamily",
          Value: "Load Balancer",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/hr",
    };
  },
};
