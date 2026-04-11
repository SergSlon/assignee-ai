import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

export const ecsClusterPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: 0,
      label: CostEstimateLabel.FREE,
      isFree: true,
      source: "free",
    };
  },
  // No mcpConfig — ECS clusters are free; costs come from tasks/services
};
