import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";

/**
 * Pricing strategy for AWS::CloudWatch::Alarm.
 *
 * Per-alarm-per-month model with resolution-based branching:
 * - Standard resolution (Period >= 60s): ~$0.10/alarm/month
 * - High resolution (Period < 60s): ~$0.30/alarm/month
 * - Free tier: 10 standard alarms
 *
 * All prices fetched from Pricing MCP at runtime.
 */
export const cloudWatchAlarmPricingStrategy: PricingStrategy = {
  estimateLocal(desiredState?: Record<string, unknown>): PricingEstimate {
    const period = Number(desiredState?.[CfnKey.PERIOD] ?? 300);
    const isHighRes = period < 60;

    return {
      perMonth: null,
      label: isHighRes
        ? "Per-alarm/month (high resolution)"
        : "Per-alarm/month (standard, 10 free tier)",
    };
  },
  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig {
    const period = Number(desiredState?.[CfnKey.PERIOD] ?? 300);
    const isHighRes = period < 60;

    return {
      serviceCode: SC.CLOUDWATCH,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.ALARM,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.ALARM_TYPE,
          Value: isHighRes ? "High Resolution" : "Standard",
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/alarm-month",
    };
  },
};
