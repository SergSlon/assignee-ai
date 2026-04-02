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

export const elbv2PricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "Hourly rate + LCU-based charges" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.ELB,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.LOAD_BALANCER,
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/hr",
    };
  },
};
