import { describe, it, expect } from "vitest";
import { dynamodbPricingDecomposer } from "./dynamodb.js";

describe("dynamodbPricingDecomposer", () => {
  it("has the correct resource type", () => {
    expect(dynamodbPricingDecomposer.resourceType).toBe("AWS::DynamoDB::Table");
  });

  describe("on-demand mode (default)", () => {
    const items = dynamodbPricingDecomposer.decompose({});

    it("returns 3 line items (read, write, storage)", () => {
      expect(items).toHaveLength(3);
    });

    it("has usage-based read and write items", () => {
      const read = items.find((i) => i.label === "Read capacity");
      const write = items.find((i) => i.label === "Write capacity");
      expect(read?.kind).toBe("usage_based");
      expect(write?.kind).toBe("usage_based");
    });

    // (f) 2026-04-09 — descriptions must call out billing mode so the
    // plan box is unambiguous about which mode the user is committing to.
    it("read/write descriptions call out PAY_PER_REQUEST explicitly", () => {
      const read = items.find((i) => i.label === "Read capacity");
      const write = items.find((i) => i.label === "Write capacity");
      expect(read?.description).toContain("On-demand (PAY_PER_REQUEST)");
      expect(read?.description).toContain("read request units");
      expect(write?.description).toContain("On-demand (PAY_PER_REQUEST)");
      expect(write?.description).toContain("write request units");
    });

    it("has usage-based storage", () => {
      const storage = items.find((i) => i.label === "Storage");
      expect(storage?.kind).toBe("usage_based");
      expect(storage?.priceUnit).toBe("/GB-mo");
    });

    it("storage description calls out PAY_PER_REQUEST mode + 25 GB free tier", () => {
      const storage = items.find((i) => i.label === "Storage");
      expect(storage?.description).toContain("PAY_PER_REQUEST");
      expect(storage?.description).toContain("25 GB free");
    });
  });

  describe("on-demand mode (explicit)", () => {
    const items = dynamodbPricingDecomposer.decompose({
      BillingMode: "PAY_PER_REQUEST",
    });

    it("returns 3 usage-based line items", () => {
      expect(items).toHaveLength(3);
      const read = items.find((i) => i.label === "Read capacity");
      expect(read?.kind).toBe("usage_based");
    });
  });

  describe("provisioned mode", () => {
    const items = dynamodbPricingDecomposer.decompose({
      BillingMode: "PROVISIONED",
      ProvisionedThroughput: {
        ReadCapacityUnits: 10,
        WriteCapacityUnits: 20,
      },
    });

    it("returns 3 line items (read, write, storage)", () => {
      expect(items).toHaveLength(3);
    });

    it("has fixed read and write items with correct quantities", () => {
      const read = items.find((i) => i.label === "Read capacity");
      const write = items.find((i) => i.label === "Write capacity");
      expect(read?.kind).toBe("fixed");
      expect(read?.quantity).toBe(10);
      expect(write?.kind).toBe("fixed");
      expect(write?.quantity).toBe(20);
    });

    // (f) 2026-04-09 — descriptions must call out PROVISIONED mode so the
    // plan box distinguishes it from on-demand at a glance.
    it("read/write descriptions call out PROVISIONED + committed units", () => {
      const read = items.find((i) => i.label === "Read capacity");
      const write = items.find((i) => i.label === "Write capacity");
      expect(read?.description).toBe(
        "Provisioned (PROVISIONED) — 10 RCUs committed",
      );
      expect(write?.description).toBe(
        "Provisioned (PROVISIONED) — 20 WCUs committed",
      );
    });

    it("storage description calls out PROVISIONED mode", () => {
      const storage = items.find((i) => i.label === "Storage");
      expect(storage?.description).toContain("PROVISIONED");
      expect(storage?.description).toContain("25 GB free");
    });

    it("uses default RCU/WCU when throughput not specified", () => {
      const defaultItems = dynamodbPricingDecomposer.decompose({
        BillingMode: "PROVISIONED",
      });
      const read = defaultItems.find((i) => i.label === "Read capacity");
      const write = defaultItems.find((i) => i.label === "Write capacity");
      expect(read?.quantity).toBe(5);
      expect(write?.quantity).toBe(5);
    });

    it("always includes storage as usage-based", () => {
      const storage = items.find((i) => i.label === "Storage");
      expect(storage?.kind).toBe("usage_based");
    });
  });

  it("all items use AmazonDynamoDB service code", () => {
    const items = dynamodbPricingDecomposer.decompose({});
    for (const item of items) {
      expect(item.serviceCode).toBe("AmazonDynamoDB");
    }
  });
});
