import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * VPC Gateway Attachment is a pure CloudFormation cross-reference linking
 * a VPC to an Internet Gateway. AWS does not charge for the attachment
 * itself — any costs come from the underlying IGW (also free) or VPC.
 */
export const vpcGatewayAttachmentPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: 0, label: CostEstimateLabel.FREE, isFree: true };
  },
};
