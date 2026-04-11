import { describe, it, expect } from "vitest";
import { elbv2PricingStrategy } from "./elbv2.js";

describe("elbv2PricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns null perMonth with hourly + LCU label", () => {
      const result = elbv2PricingStrategy.estimateLocal();
      expect(result).toEqual({
        perMonth: null,
        label: "Hourly rate + LCU-based charges",
        source: "fallback",
      });
    });
  });

  describe("mcpConfig", () => {
    it("returns ElasticLoadBalancing config with /hr unit", () => {
      const config = elbv2PricingStrategy.mcpConfig!();
      expect(config!.serviceCode).toBe("ElasticLoadBalancing");
      expect(config!.unit).toBe("/hr");
      expect(config!.filters).toHaveLength(1);
      expect(config!.filters[0]).toEqual({
        Field: "productFamily",
        Value: "Load Balancer",
        Type: "TERM_MATCH",
      });
    });
  });
});
