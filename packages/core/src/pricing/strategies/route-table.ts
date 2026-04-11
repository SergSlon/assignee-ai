import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

export const routeTablePricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: null,
      label: CostEstimateLabel.NO_CHARGE,
      isFree: true,
      source: "free",
    };
  },
  // No mcpConfig — Route tables and routes are free AWS resources
};
