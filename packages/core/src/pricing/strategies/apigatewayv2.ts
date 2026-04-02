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
 * Pricing strategy for AWS::ApiGatewayV2::Api.
 *
 * Per-request model with protocol-based branching:
 * - HTTP API: per-request pricing (tiered)
 * - WebSocket: per-connection-minute + per-message pricing
 *
 * All prices fetched from Pricing MCP at runtime — zero hardcoded dollar amounts.
 */
export const apiGatewayV2PricingStrategy: PricingStrategy = {
  estimateLocal(desiredState?: Record<string, unknown>): PricingEstimate {
    const protocol = desiredState?.[CfnKey.PROTOCOL_TYPE] ?? "HTTP";
    if (protocol === "WEBSOCKET") {
      return {
        perMonth: null,
        label:
          "WebSocket — per-connection-minute + per-message pricing (query Pricing MCP)",
      };
    }
    return {
      perMonth: null,
      label: "HTTP API — per-request pricing (query Pricing MCP)",
    };
  },

  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig | null {
    const protocol = desiredState?.[CfnKey.PROTOCOL_TYPE] ?? "HTTP";

    if (protocol === "WEBSOCKET") {
      return {
        serviceCode: SC.API_GATEWAY,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.WEBSOCKET, Type: M.TERM_MATCH },
          {
            Field: F.USAGE_TYPE,
            Value: "ApiGatewayMessage",
            Type: M.TERM_MATCH,
          },
        ],
        unit: "/million messages",
        scale: 1_000_000,
      };
    }

    // HTTP API — per-request pricing
    return {
      serviceCode: SC.API_GATEWAY,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_CALLS, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: "ApiGatewayHttpRequest",
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/million requests",
      scale: 1_000_000,
    };
  },
};
