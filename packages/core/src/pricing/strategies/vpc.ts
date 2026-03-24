import type { PricingStrategy, PricingEstimate } from "../types.js";

export const vpcPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: 0, label: "Free", isFree: true };
  },
  // No mcpConfig — VPCs are always free, no MCP query needed
};
