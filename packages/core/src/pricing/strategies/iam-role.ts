import type { PricingStrategy, PricingEstimate } from "../types.js";

export const iamRolePricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: 0, label: "Free", isFree: true };
  },
  // No mcpConfig — IAM roles are always free, no MCP query needed
};
