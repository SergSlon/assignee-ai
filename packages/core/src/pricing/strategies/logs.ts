import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

/**
 * Pricing strategy for AWS::Logs::LogGroup.
 * Dual-dimension pricing: ingestion (per GB collected) + storage (per GB archived/month).
 * Free tier: 5GB ingestion + 5GB storage + 5GB scanned per month.
 * All prices come from the Pricing MCP at runtime — zero hardcoded dollar amounts.
 */
export const logsPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "N/A" };
  },
  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig {
    const logGroupClass =
      (desiredState?.["LogGroupClass"] as string) ?? "STANDARD";
    const isInfrequentAccess = logGroupClass === "INFREQUENT_ACCESS";

    return {
      serviceCode: "AmazonCloudWatch",
      filters: [
        { Field: "productFamily", Value: "Logs", Type: "TERM_MATCH" },
        {
          Field: "usagetype",
          Value: isInfrequentAccess
            ? "CW:LogInfrequentAccess-DataProcessing-Bytes"
            : "CW:DataProcessing-Bytes",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/GB ingested (5GB/mo free tier)",
    };
  },
};
