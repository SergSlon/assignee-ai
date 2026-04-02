import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

import { EXTENDED_TIMEOUT_MS } from "../constants.js";
import { CfnKey } from "../../config/cfn-keys.js";
import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
  CostEstimateLabel,
} from "../filter-constants.js";

const DEFAULT_INSTANCE_TYPE = "t3.micro";

export const ec2PricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA };
  },
  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig {
    const instanceType =
      (desiredState?.[CfnKey.INSTANCE_TYPE] as string | undefined) ??
      DEFAULT_INSTANCE_TYPE;
    return {
      serviceCode: SC.EC2,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.COMPUTE_INSTANCE,
          Type: M.TERM_MATCH,
        },
        { Field: F.INSTANCE_TYPE, Value: instanceType, Type: M.TERM_MATCH },
        { Field: F.OPERATING_SYSTEM, Value: "Linux", Type: M.TERM_MATCH },
        { Field: F.TENANCY, Value: "Shared", Type: M.TERM_MATCH },
        { Field: F.CAPACITY_STATUS, Value: "Used", Type: M.TERM_MATCH },
        { Field: F.PRE_INSTALLED_SW, Value: "NA", Type: M.TERM_MATCH },
      ],
      unit: "/hour",
      timeoutMs: EXTENDED_TIMEOUT_MS,
    };
  },
};
