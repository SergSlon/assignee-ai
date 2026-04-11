import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";
import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
  CostEstimateLabel,
} from "../filter-constants.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";

export const ssmPricingStrategy: PricingStrategy = {
  estimateLocal(desiredState?: Record<string, unknown>): PricingEstimate {
    // SSM Parameter pricing depends on tier:
    //   - Standard tier (default): always free, up to 10K parameters per account
    //   - Advanced tier: usage-based ($0.05/parameter-month + API call charges),
    //     handled by the SSM decomposer.
    // For all non-parameter SSM resources (no tier key) we also assume free —
    // SSM itself has no flat charge for documents/associations/etc.
    const tier = desiredState?.[CfnKey.TIER];
    const tierStr =
      typeof tier === "string"
        ? tier.toLowerCase()
        : AwsDefault.SSM_TIER_STANDARD.toLowerCase();

    if (tierStr === AwsDefault.SSM_TIER_STANDARD.toLowerCase()) {
      return {
        perMonth: 0,
        label: CostEstimateLabel.FREE,
        isFree: true,
        source: "free",
      };
    }

    // Advanced (or any non-standard tier) — defer to the decomposer / MCP query.
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig | null {
    // Standard tier is always free — no need to query the Pricing API.
    const tier = desiredState?.[CfnKey.TIER];
    const tierStr =
      typeof tier === "string"
        ? tier.toLowerCase()
        : AwsDefault.SSM_TIER_STANDARD.toLowerCase();
    if (tierStr === AwsDefault.SSM_TIER_STANDARD.toLowerCase()) {
      return null;
    }
    return {
      serviceCode: SC.SSM,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.SYSTEMS_MANAGER,
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/param-hour",
    };
  },
};
