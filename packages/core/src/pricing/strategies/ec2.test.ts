import { describe, it, expect } from "vitest";
import { ec2PricingStrategy } from "./ec2.js";

describe("ec2PricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns null perMonth and N/A label", () => {
      const result = ec2PricingStrategy.estimateLocal();
      expect(result).toEqual({
        perMonth: null,
        label: "N/A",
        source: "fallback",
      });
    });
  });

  describe("mcpConfig", () => {
    it("uses default t3.micro when no desiredState provided", () => {
      const config = ec2PricingStrategy.mcpConfig!();
      expect(config).not.toBeNull();
      expect(config!.serviceCode).toBe("AmazonEC2");
      expect(config!.unit).toBe("/hour");
      expect(config!.timeoutMs).toBe(8000);
      const instanceFilter = config!.filters.find(
        (f) => f.Field === "instanceType",
      );
      expect(instanceFilter?.Value).toBe("t3.micro");
    });

    it("uses InstanceType from desiredState when provided", () => {
      const config = ec2PricingStrategy.mcpConfig!({
        InstanceType: "m5.xlarge",
      });
      const instanceFilter = config!.filters.find(
        (f) => f.Field === "instanceType",
      );
      expect(instanceFilter?.Value).toBe("m5.xlarge");
    });

    it("falls back to t3.micro when desiredState has no InstanceType", () => {
      const config = ec2PricingStrategy.mcpConfig!({ other: "value" });
      const instanceFilter = config!.filters.find(
        (f) => f.Field === "instanceType",
      );
      expect(instanceFilter?.Value).toBe("t3.micro");
    });
  });
});
