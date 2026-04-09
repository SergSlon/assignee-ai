import { describe, it, expect } from "vitest";
import { ssmPricingDecomposer } from "./ssm.js";

describe("ssmPricingDecomposer", () => {
  it("has resourceType AWS::SSM::Parameter", () => {
    expect(ssmPricingDecomposer.resourceType).toBe("AWS::SSM::Parameter");
  });

  it("default (no Tier) returns empty array (Standard = free)", () => {
    const items = ssmPricingDecomposer.decompose({});
    expect(items).toEqual([]);
  });

  it('Tier: "Standard" returns empty array', () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "Standard" });
    expect(items).toEqual([]);
  });

  it('Tier: "Advanced" returns 2 items (storage + API)', () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "Advanced" });
    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("Parameter storage");
    expect(items[1]!.label).toBe("API calls");
  });

  it("Advanced storage is fixed with quantity 1", () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "Advanced" });
    expect(items[0]!.kind).toBe("fixed");
    expect(items[0]!.quantity).toBe(1);
  });

  // (f) 2026-04-09 — description must make tier + billing model obvious
  // at plan time. Zero hardcoded dollar amounts per pricing rules.
  it("Advanced storage description calls out tier + 'billed per param'", () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "Advanced" });
    expect(items[0]!.description).toContain("Advanced tier");
    expect(items[0]!.description).toContain("billed per param");
    // Defensive: no hardcoded dollar amounts allowed in descriptions.
    expect(items[0]!.description).not.toMatch(/\$\d/);
  });

  it("Advanced API description calls out tier + per 10k unit", () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "Advanced" });
    expect(items[1]!.description).toContain("Advanced tier");
    expect(items[1]!.description).toContain("10k");
    expect(items[1]!.description).not.toMatch(/\$\d/);
  });

  it("Advanced API is usage_based with quantity 0", () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "Advanced" });
    expect(items[1]!.kind).toBe("usage_based");
    expect(items[1]!.quantity).toBe(0);
  });

  it("all Advanced items use AWSSystemsManager serviceCode", () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "Advanced" });
    for (const item of items) {
      expect(item.serviceCode).toBe("AWSSystemsManager");
    }
  });

  it("all filters use TERM_MATCH", () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "Advanced" });
    for (const item of items) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("empty desiredState {} returns empty array", () => {
    const items = ssmPricingDecomposer.decompose({});
    expect(items).toEqual([]);
  });

  it('Tier: "ADVANCED" (uppercase) returns 2 items via case-insensitive match', () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "ADVANCED" });
    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("Parameter storage");
    expect(items[1]!.label).toBe("API calls");
  });

  it('Tier: "standard" (lowercase) returns empty array', () => {
    const items = ssmPricingDecomposer.decompose({ Tier: "standard" });
    expect(items).toEqual([]);
  });
});
