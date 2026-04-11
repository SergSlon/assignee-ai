import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

export const internetGatewayPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: null,
      label: CostEstimateLabel.NO_CHARGE,
      isFree: true,
      source: "free",
    };
  },
  // No mcpConfig — InternetGateways are free; data transfer charges are not IGW-specific
};
