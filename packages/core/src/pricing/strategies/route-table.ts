import type { PricingStrategy, PricingEstimate } from "../types.js";

export const routeTablePricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "No charge", isFree: true };
  },
  // No mcpConfig — Route tables and routes are free AWS resources
};
