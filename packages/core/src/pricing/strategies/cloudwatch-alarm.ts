import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

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
    const period = Number(desiredState?.["Period"] ?? 300);
    const isHighRes = period < 60;

    return {
      perMonth: null,
      label: isHighRes
        ? "Per-alarm/month (high resolution)"
        : "Per-alarm/month (standard, 10 free tier)",
    };
  },
  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig {
    const period = Number(desiredState?.["Period"] ?? 300);
    const isHighRes = period < 60;

    return {
      serviceCode: "AmazonCloudWatch",
      filters: [
        {
          Field: "productFamily",
          Value: "Alarm",
          Type: "TERM_MATCH",
        },
        {
          Field: "alarmType",
          Value: isHighRes ? "High Resolution" : "Standard",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/alarm-month",
    };
  },
};
