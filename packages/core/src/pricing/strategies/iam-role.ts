import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

export const iamRolePricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: 0,
      label: CostEstimateLabel.FREE,
      isFree: true,
      source: "free",
    };
  },
  // No mcpConfig — IAM roles are always free, no MCP query needed
};
