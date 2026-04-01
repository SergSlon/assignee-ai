/**
 * Tests for API Gateway V2 pricing decomposer (Story 23.3).
 * Verifies line item generation for HTTP API and WebSocket API protocols.
 */

import { describe, it, expect } from "vitest";
import { apigatewayV2PricingDecomposer } from "./apigatewayv2.js";

describe("apigatewayV2PricingDecomposer", () => {
  it("has correct resourceType", () => {
    expect(apigatewayV2PricingDecomposer.resourceType).toBe(
      "AWS::ApiGatewayV2::Api",
    );
  });

  it("returns 2 HTTP items when no ProtocolType is specified", () => {
    const items = apigatewayV2PricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.label)).toEqual([
      "Requests",
      "Data transfer out",
    ]);
  });

  it("returns 2 HTTP items when ProtocolType is HTTP", () => {
    const items = apigatewayV2PricingDecomposer.decompose({
      ProtocolType: "HTTP",
    });

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.label)).toEqual([
      "Requests",
      "Data transfer out",
    ]);
  });

  it("returns 2 WebSocket items when ProtocolType is WEBSOCKET", () => {
    const items = apigatewayV2PricingDecomposer.decompose({
      ProtocolType: "WEBSOCKET",
    });

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.label)).toEqual([
      "Messages",
      "Connection minutes",
    ]);
  });

  it("HTTP Requests uses AmazonApiGateway serviceCode", () => {
    const items = apigatewayV2PricingDecomposer.decompose({
      ProtocolType: "HTTP",
    });
    const requests = items.find((i) => i.label === "Requests")!;

    expect(requests.serviceCode).toBe("AmazonApiGateway");
  });

  it("WebSocket Messages uses AmazonApiGateway serviceCode", () => {
    const items = apigatewayV2PricingDecomposer.decompose({
      ProtocolType: "WEBSOCKET",
    });
    const messages = items.find((i) => i.label === "Messages")!;

    expect(messages.serviceCode).toBe("AmazonApiGateway");
  });

  it("all items are usage_based with quantity 0", () => {
    const httpItems = apigatewayV2PricingDecomposer.decompose({});
    const wsItems = apigatewayV2PricingDecomposer.decompose({
      ProtocolType: "WEBSOCKET",
    });

    for (const item of [...httpItems, ...wsItems]) {
      expect(item.kind).toBe("usage_based");
      expect(item.quantity).toBe(0);
    }
  });

  it("all filters use TERM_MATCH type", () => {
    const httpItems = apigatewayV2PricingDecomposer.decompose({});
    const wsItems = apigatewayV2PricingDecomposer.decompose({
      ProtocolType: "WEBSOCKET",
    });

    for (const item of [...httpItems, ...wsItems]) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("empty desiredState works", () => {
    const items = apigatewayV2PricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("Requests");
  });
});
