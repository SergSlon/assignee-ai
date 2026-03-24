import type { PricingStrategy, PricingEstimate } from "../types.js";

export const internetGatewayPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "No charge", isFree: true };
  },
  // No mcpConfig — InternetGateways are free; data transfer charges are not IGW-specific
};
