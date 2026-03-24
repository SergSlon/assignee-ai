import type { PricingStrategy, PricingEstimate } from "../types.js";

export const subnetPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: 0, label: "Free", isFree: true };
  },
  // No mcpConfig — Subnets are always free, no MCP query needed
};
