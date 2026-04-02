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
  CostEstimateLabel,
} from "../filter-constants.js";

export const ssmPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.SSM,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.SYSTEMS_MANAGER,
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/param-hour",
    };
  },
};
