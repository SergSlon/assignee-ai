import { describe, it, expect } from "vitest";
import { logsPricingStrategy } from "./logs.js";

describe("logsPricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns null perMonth and N/A label", () => {
      const result = logsPricingStrategy.estimateLocal();
      expect(result).toEqual({
        perMonth: null,
        label: "N/A",
        source: "fallback",
      });
    });
  });

  describe("mcpConfig", () => {
    it("defaults to STANDARD log group class", () => {
      const config = logsPricingStrategy.mcpConfig!();
      expect(config!.serviceCode).toBe("AmazonCloudWatch");
      expect(config!.unit).toBe("/GB ingested (5GB/mo free tier)");
      const usageFilter = config!.filters.find((f) => f.Field === "usagetype");
      expect(usageFilter?.Value).toBe("CW:DataProcessing-Bytes");
    });

    it("uses STANDARD usagetype when LogGroupClass is STANDARD", () => {
      const config = logsPricingStrategy.mcpConfig!({
        LogGroupClass: "STANDARD",
      });
      const usageFilter = config!.filters.find((f) => f.Field === "usagetype");
      expect(usageFilter?.Value).toBe("CW:DataProcessing-Bytes");
    });

    it("uses INFREQUENT_ACCESS usagetype when LogGroupClass is INFREQUENT_ACCESS", () => {
      const config = logsPricingStrategy.mcpConfig!({
        LogGroupClass: "INFREQUENT_ACCESS",
      });
      const usageFilter = config!.filters.find((f) => f.Field === "usagetype");
      expect(usageFilter?.Value).toBe(
        "CW:LogInfrequentAccess-DataProcessing-Bytes",
      );
    });
  });
});
