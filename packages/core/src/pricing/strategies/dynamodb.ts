import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";
import { CfnKey } from "../../config/cfn-keys.js";

/**
 * DynamoDB pricing strategy.
 * On-demand: per-request pricing. Provisioned: per-WCU/RCU-hour.
 * All prices fetched from Pricing MCP at runtime — local fallback returns N/A.
 */
export const dynamodbPricingStrategy: PricingStrategy = {
  estimateLocal(desiredState?: Record<string, unknown>): PricingEstimate {
    const billingMode = desiredState?.[CfnKey.BILLING_MODE] as
      | string
      | undefined;
    const label =
      billingMode === "PROVISIONED"
        ? "Provisioned (per RCU/WCU-hour)"
        : "On-demand (per-request)";
    return { perMonth: null, label };
  },

  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig | null {
    const billingMode = desiredState?.[CfnKey.BILLING_MODE] as
      | string
      | undefined;

    if (billingMode === "PROVISIONED") {
      // Query for write capacity unit hourly rate (representative line item)
      return {
        serviceCode: "AmazonDynamoDB",
        filters: [
          {
            Field: "productFamily",
            Value: "Provisioned IOPS",
            Type: "TERM_MATCH",
          },
          { Field: "group", Value: "DDB-WriteUnits", Type: "TERM_MATCH" },
        ],
        unit: "/WCU-hr",
      };
    }

    // On-demand: query write request units
    return {
      serviceCode: "AmazonDynamoDB",
      filters: [
        {
          Field: "productFamily",
          Value: "Amazon DynamoDB PayPerRequest Throughput",
          Type: "TERM_MATCH",
        },
        { Field: "group", Value: "DDB-WriteUnits", Type: "TERM_MATCH" },
      ],
      unit: "/M write req",
    };
  },
};
