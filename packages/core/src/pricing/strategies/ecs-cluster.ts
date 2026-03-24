import type { PricingStrategy, PricingEstimate } from "../types.js";

export const ecsClusterPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: 0, label: "Free", isFree: true };
  },
  // No mcpConfig — ECS clusters are free; costs come from tasks/services
};
