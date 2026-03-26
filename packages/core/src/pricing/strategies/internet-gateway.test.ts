import { describe, it, expect } from "vitest";
import { internetGatewayPricingStrategy } from "./internet-gateway.js";

describe("internetGatewayPricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns free estimate with no charge label", () => {
      const result = internetGatewayPricingStrategy.estimateLocal();
      expect(result).toEqual({
        perMonth: null,
        label: "No charge",
        isFree: true,
      });
    });
  });

  it("has no mcpConfig (IGWs are free)", () => {
    expect(internetGatewayPricingStrategy.mcpConfig).toBeUndefined();
  });
});
