import { describe, it, expect } from "vitest";
import { secretsManagerPricingDecomposer } from "./secretsmanager.js";

describe("secretsManagerPricingDecomposer", () => {
  it("has resourceType AWS::SecretsManager::Secret", () => {
    expect(secretsManagerPricingDecomposer.resourceType).toBe(
      "AWS::SecretsManager::Secret",
    );
  });

  it("returns 2 items (Secret storage + API calls)", () => {
    const items = secretsManagerPricingDecomposer.decompose({});
    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("Secret storage");
    expect(items[1]!.label).toBe("API calls");
  });

  it("Secret storage is fixed with quantity 1", () => {
    const items = secretsManagerPricingDecomposer.decompose({});
    expect(items[0]!.kind).toBe("fixed");
    expect(items[0]!.quantity).toBe(1);
  });

  it("API calls is usage_based with quantity 0", () => {
    const items = secretsManagerPricingDecomposer.decompose({});
    expect(items[1]!.kind).toBe("usage_based");
    expect(items[1]!.quantity).toBe(0);
  });

  it("all items use AWSSecretsManager serviceCode", () => {
    const items = secretsManagerPricingDecomposer.decompose({});
    for (const item of items) {
      expect(item.serviceCode).toBe("AWSSecretsManager");
    }
  });

  it("all filters use TERM_MATCH", () => {
    const items = secretsManagerPricingDecomposer.decompose({});
    for (const item of items) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("empty desiredState {} works", () => {
    const items = secretsManagerPricingDecomposer.decompose({});
    expect(items).toHaveLength(2);
  });

  it("API calls uses productFamily 'API Request' filter (not usagetype)", () => {
    const items = secretsManagerPricingDecomposer.decompose({});
    const apiItem = items.find((i) => i.label === "API calls")!;
    const filterFields = apiItem.filters.map((f) => f.Field);
    expect(filterFields).toContain("productFamily");
    expect(filterFields).not.toContain("usagetype");
    const pfFilter = apiItem.filters.find((f) => f.Field === "productFamily")!;
    expect(pfFilter.Value).toBe("API Request");
  });

  it("Secret storage uses productFamily 'Secret' filter (not usagetype)", () => {
    const items = secretsManagerPricingDecomposer.decompose({});
    const storageItem = items.find((i) => i.label === "Secret storage")!;
    const filterFields = storageItem.filters.map((f) => f.Field);
    expect(filterFields).toContain("productFamily");
    expect(filterFields).not.toContain("usagetype");
    const pfFilter = storageItem.filters.find(
      (f) => f.Field === "productFamily",
    )!;
    expect(pfFilter.Value).toBe("Secret");
  });
});
