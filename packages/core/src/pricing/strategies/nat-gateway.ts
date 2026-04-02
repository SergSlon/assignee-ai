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
} from "../filter-constants.js";

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
      serviceCode: SC.EC2,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.NAT_GATEWAY,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.USAGE_TYPE,
          Value: "NatGateway-Hours",
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/hour",
    };
  },
};
