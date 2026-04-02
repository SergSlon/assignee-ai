import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

export const securityGroupPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: 0, label: CostEstimateLabel.FREE, isFree: true };
  },
  // No mcpConfig — security groups are always free, no MCP query needed
};
