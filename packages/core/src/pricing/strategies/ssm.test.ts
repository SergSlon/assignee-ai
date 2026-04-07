import { describe, it, expect } from "vitest";
import { ssmPricingStrategy } from "./ssm.js";
import { CostEstimateLabel } from "../filter-constants.js";
import { CfnKey } from "../../config/cfn-keys.js";

describe("ssmPricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns FREE for Standard tier (default when Tier omitted)", () => {
      // Real-shaped SSM parameter desiredState as produced by the plan generator.
      const desiredState = {
        Name: "/app/db/host",
        Type: "String",
        Value: "db.internal.example.com",
      };
      const result = ssmPricingStrategy.estimateLocal(desiredState);
      expect(result).toEqual({
        perMonth: 0,
        label: CostEstimateLabel.FREE,
        isFree: true,
      });
    });

    it("returns FREE when Tier is explicitly Standard", () => {
      const desiredState = {
        Name: "/app/api/key",
        Type: "SecureString",
        Value: "secret-value",
        [CfnKey.TIER]: "Standard",
      };
      const result = ssmPricingStrategy.estimateLocal(desiredState);
      expect(result).toEqual({
        perMonth: 0,
        label: CostEstimateLabel.FREE,
        isFree: true,
      });
    });

    it("returns FREE for Standard tier with mixed-case input", () => {
      const result = ssmPricingStrategy.estimateLocal({
        [CfnKey.TIER]: "STANDARD",
      });
      expect(result.isFree).toBe(true);
      expect(result.label).toBe(CostEstimateLabel.FREE);
    });

    it("returns N/A for Advanced tier (decomposer handles billable components)", () => {
      const desiredState = {
        Name: "/app/large/blob",
        Type: "String",
        Value: "x".repeat(5000),
        [CfnKey.TIER]: "Advanced",
      };
      const result = ssmPricingStrategy.estimateLocal(desiredState);
      expect(result).toEqual({
        perMonth: null,
        label: CostEstimateLabel.NA,
      });
    });

    it("returns N/A for Intelligent-Tiering (non-standard tier)", () => {
      const result = ssmPricingStrategy.estimateLocal({
        [CfnKey.TIER]: "Intelligent-Tiering",
      });
      expect(result.label).toBe(CostEstimateLabel.NA);
      expect(result.perMonth).toBeNull();
    });

    it("returns FREE when called without arguments (e.g. non-parameter SSM resource)", () => {
      const result = ssmPricingStrategy.estimateLocal();
      expect(result).toEqual({
        perMonth: 0,
        label: CostEstimateLabel.FREE,
        isFree: true,
      });
    });
  });

  describe("mcpConfig", () => {
    it("returns null for Standard tier (no Pricing API call needed)", () => {
      const config = ssmPricingStrategy.mcpConfig?.({
        Name: "/app/db/host",
        Type: "String",
        Value: "db.internal.example.com",
      });
      expect(config).toBeNull();
    });

    it("returns null when Tier is explicitly Standard", () => {
      const config = ssmPricingStrategy.mcpConfig?.({
        [CfnKey.TIER]: "Standard",
      });
      expect(config).toBeNull();
    });

    it("returns a real Pricing API config for Advanced tier", () => {
      const config = ssmPricingStrategy.mcpConfig?.({
        [CfnKey.TIER]: "Advanced",
      });
      expect(config).not.toBeNull();
      expect(config?.serviceCode).toBe("AWSSystemsManager");
      expect(config?.unit).toBe("/param-hour");
      expect(config?.filters.length).toBeGreaterThan(0);
    });

    it("returns null when called with no desiredState (defaults to Standard)", () => {
      const config = ssmPricingStrategy.mcpConfig?.();
      expect(config).toBeNull();
    });
  });
});
