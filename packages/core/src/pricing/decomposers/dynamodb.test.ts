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

    it("has usage-based storage", () => {
      const storage = items.find((i) => i.label === "Storage");
      expect(storage?.kind).toBe("usage_based");
      expect(storage?.priceUnit).toBe("/GB-mo");
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
      expect(read?.description).toBe("10 RCUs");
      expect(write?.kind).toBe("fixed");
      expect(write?.quantity).toBe(20);
      expect(write?.description).toBe("20 WCUs");
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
