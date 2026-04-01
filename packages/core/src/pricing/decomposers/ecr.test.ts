import { describe, it, expect } from "vitest";
import { ecrPricingDecomposer } from "./ecr.js";

describe("ecrPricingDecomposer", () => {
  it("has resourceType AWS::ECR::Repository", () => {
    expect(ecrPricingDecomposer.resourceType).toBe("AWS::ECR::Repository");
  });

  it("returns 1 item (Storage)", () => {
    const items = ecrPricingDecomposer.decompose({});
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Storage");
  });

  it("item is usage_based with quantity 0", () => {
    const items = ecrPricingDecomposer.decompose({});
    expect(items[0]!.kind).toBe("usage_based");
    expect(items[0]!.quantity).toBe(0);
  });

  it("uses AmazonECR serviceCode", () => {
    const items = ecrPricingDecomposer.decompose({});
    expect(items[0]!.serviceCode).toBe("AmazonECR");
  });

  it("all filters use TERM_MATCH", () => {
    const items = ecrPricingDecomposer.decompose({});
    for (const item of items) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("empty desiredState {} works", () => {
    const items = ecrPricingDecomposer.decompose({});
    expect(items).toHaveLength(1);
  });
});
