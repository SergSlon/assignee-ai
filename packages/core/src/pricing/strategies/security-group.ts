import type { PricingStrategy, PricingEstimate } from "../types.js";

export const securityGroupPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: 0, label: "Free", isFree: true };
  },
  // No mcpConfig — security groups are always free, no MCP query needed
};
