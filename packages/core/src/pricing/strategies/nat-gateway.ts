import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

/**
 * Pricing strategy for AWS::EC2::NatGateway.
 * Dual-dimension pricing: hourly rate (per NatGateway-hour) + per-GB data processing.
 * All prices come from the Pricing MCP at runtime — zero hardcoded dollar amounts.
 * There is no free tier for NatGateway.
 *
 * @see Story 25.4
 */
export const natGatewayPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "Hourly + per-GB data processing" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: "AmazonEC2",
      filters: [
        {
          Field: "productFamily",
          Value: "NAT Gateway",
          Type: "TERM_MATCH",
        },
        {
          Field: "usagetype",
          Value: "NatGateway-Hours",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/hour",
    };
  },
};
