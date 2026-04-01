/**
 * Tests for NAT Gateway pricing decomposer (Story 23.3).
 * Verifies line item generation for hourly rate and data processing.
 */

import { describe, it, expect } from "vitest";
import { natGatewayPricingDecomposer } from "./nat-gateway.js";

describe("natGatewayPricingDecomposer", () => {
  it("has correct resourceType", () => {
    expect(natGatewayPricingDecomposer.resourceType).toBe(
      "AWS::EC2::NatGateway",
    );
  });

  it("returns 2 line items (hourly + data processing)", () => {
    const items = natGatewayPricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.label)).toEqual([
      "Hourly rate",
      "Data processing",
    ]);
  });

  it("hourly item is fixed with quantity 1", () => {
    const items = natGatewayPricingDecomposer.decompose({});
    const hourly = items.find((i) => i.label === "Hourly rate")!;

    expect(hourly.kind).toBe("fixed");
    expect(hourly.quantity).toBe(1);
    expect(hourly.unit).toBe("gateway");
    expect(hourly.serviceCode).toBe("AmazonEC2");
    expect(hourly.priceUnit).toBe("/hr");
  });

  it("data processing is usage_based with quantity 0", () => {
    const items = natGatewayPricingDecomposer.decompose({});
    const dataProcessing = items.find((i) => i.label === "Data processing")!;

    expect(dataProcessing.kind).toBe("usage_based");
    expect(dataProcessing.quantity).toBe(0);
    expect(dataProcessing.unit).toBe("GB");
    expect(dataProcessing.serviceCode).toBe("AmazonEC2");
    expect(dataProcessing.priceUnit).toBe("/GB");
  });

  it("all filters use TERM_MATCH type", () => {
    const items = natGatewayPricingDecomposer.decompose({});
    for (const item of items) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("works with empty desiredState", () => {
    const items = natGatewayPricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items[0]!.description).toBe("NAT Gateway");
  });

  it("with ConnectivityType public gives same line items", () => {
    const itemsPublic = natGatewayPricingDecomposer.decompose({
      ConnectivityType: "public",
    });
    const itemsEmpty = natGatewayPricingDecomposer.decompose({});

    expect(itemsPublic).toHaveLength(2);
    expect(itemsPublic.map((i) => i.label)).toEqual(
      itemsEmpty.map((i) => i.label),
    );
    expect(itemsPublic.map((i) => i.kind)).toEqual(
      itemsEmpty.map((i) => i.kind),
    );
    expect(itemsPublic[0]!.description).toBe("NAT Gateway (public)");
  });

  it("hourly item has correct filters", () => {
    const items = natGatewayPricingDecomposer.decompose({});
    const hourly = items.find((i) => i.label === "Hourly rate")!;

    expect(hourly.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "NAT Gateway",
        }),
        expect.objectContaining({
          Field: "usagetype",
          Value: "NatGateway-Hours",
        }),
      ]),
    );
  });

  it("data processing item has correct filters", () => {
    const items = natGatewayPricingDecomposer.decompose({});
    const dataProcessing = items.find((i) => i.label === "Data processing")!;

    expect(dataProcessing.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "NAT Gateway",
        }),
        expect.objectContaining({
          Field: "usagetype",
          Value: "NatGateway-Bytes",
        }),
      ]),
    );
  });
});
