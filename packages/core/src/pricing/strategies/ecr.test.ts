import { describe, it, expect } from "vitest";
import { ecrPricingStrategy } from "./ecr.js";

describe("ecrPricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns null perMonth with per-GB label", () => {
      const result = ecrPricingStrategy.estimateLocal();
      expect(result).toEqual({
        perMonth: null,
        label: "Per-GB monthly storage",
        source: "fallback",
      });
    });
  });

  describe("mcpConfig", () => {
    it("returns AmazonECR service code with /GB-month unit", () => {
      const config = ecrPricingStrategy.mcpConfig!();
      expect(config).not.toBeNull();
      expect(config!.serviceCode).toBe("AmazonECR");
      expect(config!.unit).toBe("/GB-month");
      expect(config!.filters).toHaveLength(1);
      expect(config!.filters![0]!.Value).toBe("EC2 Container Registry");
    });
  });
});
