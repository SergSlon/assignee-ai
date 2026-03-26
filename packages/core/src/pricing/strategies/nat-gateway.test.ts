import { describe, it, expect } from "vitest";
import { natGatewayPricingStrategy } from "./nat-gateway.js";

describe("natGatewayPricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns null perMonth with hourly + per-GB label", () => {
      const result = natGatewayPricingStrategy.estimateLocal();
      expect(result).toEqual({
        perMonth: null,
        label: "Hourly + per-GB data processing",
      });
    });
  });

  describe("mcpConfig", () => {
    it("returns AmazonEC2 config for NAT Gateway with /hour unit", () => {
      const config = natGatewayPricingStrategy.mcpConfig!();
      expect(config!.serviceCode).toBe("AmazonEC2");
      expect(config!.unit).toBe("/hour");
      expect(config!.filters).toEqual([
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
      ]);
    });
  });
});
