import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Subnet ↔ Route Table Association is a pure CloudFormation cross-reference
 * linking a subnet to a route table. AWS does not charge for the association
 * itself — any costs come from the underlying subnet or route table (both free).
 */
export const subnetRouteTableAssociationPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: 0,
      label: CostEstimateLabel.FREE,
      isFree: true,
      source: "free",
    };
  },
};
