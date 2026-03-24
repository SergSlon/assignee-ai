import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

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
    const protocol = desiredState?.["ProtocolType"] ?? "HTTP";
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
    const protocol = desiredState?.["ProtocolType"] ?? "HTTP";

    if (protocol === "WEBSOCKET") {
      return {
        serviceCode: "AmazonApiGateway",
        filters: [
          { Field: "productFamily", Value: "WebSocket", Type: "TERM_MATCH" },
          {
            Field: "usagetype",
            Value: "ApiGatewayMessage",
            Type: "TERM_MATCH",
          },
        ],
        unit: "/million messages",
        scale: 1_000_000,
      };
    }

    // HTTP API — per-request pricing
    return {
      serviceCode: "AmazonApiGateway",
      filters: [
        { Field: "productFamily", Value: "API Calls", Type: "TERM_MATCH" },
        {
          Field: "usagetype",
          Value: "ApiGatewayHttpRequest",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/million requests",
      scale: 1_000_000,
    };
  },
};
