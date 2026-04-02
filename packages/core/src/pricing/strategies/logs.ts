import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
  CostEstimateLabel,
} from "../filter-constants.js";

/**
 * Pricing strategy for AWS::Logs::LogGroup.
 * Dual-dimension pricing: ingestion (per GB collected) + storage (per GB archived/month).
 * Free tier: 5GB ingestion + 5GB storage + 5GB scanned per month.
 * All prices come from the Pricing MCP at runtime — zero hardcoded dollar amounts.
 */
export const logsPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA };
  },
  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig {
    const logGroupClass =
      (desiredState?.[CfnKey.LOG_GROUP_CLASS] as string) ??
      AwsDefault.LOG_CLASS_STANDARD;
    const isInfrequentAccess =
      logGroupClass === AwsDefault.LOG_CLASS_INFREQUENT;

    return {
      serviceCode: SC.CLOUDWATCH,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.LOGS, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: isInfrequentAccess
            ? "CW:LogInfrequentAccess-DataProcessing-Bytes"
            : "CW:DataProcessing-Bytes",
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/GB ingested (5GB/mo free tier)",
    };
  },
};
