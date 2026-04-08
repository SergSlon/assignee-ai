import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * EFS MountTarget pricing — free. The billable cost lives on the
 * parent AWS::EFS::FileSystem (storage per GB-month) and on data
 * transfer for NFS traffic across the VPC. Mount targets themselves
 * are a pure CFN attachment construct with no line item on the AWS
 * invoice.
 *
 * @see A1 follow-up — EFS MountTarget first-class support
 */
export const efsMountTargetPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: 0, label: CostEstimateLabel.FREE, isFree: true };
  },
  // No mcpConfig — MountTargets have no billable component.
};
