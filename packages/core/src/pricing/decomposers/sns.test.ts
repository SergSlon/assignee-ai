/**
 * Tests for SNS pricing decomposer (Story 23.3).
 * Verifies line item generation for Standard and FIFO topics.
 * Updated EPIC-106-SNS: asserts corrected filter shapes (group-based, not
 * usagetype-based) matching the real AWS Pricing API response shape.
 */

import { describe, it, expect } from "vitest";
import { snsPricingDecomposer } from "./sns.js";
import {
  snsPublishes,
  snsHttpDelivery,
} from "../../test-fixtures/mcp-mock-responses/pricing-sns.js";

describe("snsPricingDecomposer", () => {
  it("has correct resourceType", () => {
    expect(snsPricingDecomposer.resourceType).toBe("AWS::SNS::Topic");
  });

  it("returns 2 items by default (Publishes + HTTP notifications)", () => {
    const items = snsPricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.label)).toEqual([
      "Publishes",
      "HTTP notifications",
    ]);
  });

  it("FifoTopic true still returns 2 items with FIFO description", () => {
    const items = snsPricingDecomposer.decompose({ FifoTopic: true });

    expect(items).toHaveLength(2);
    const publishes = items.find((i) => i.label === "Publishes")!;
    expect(publishes.description).toBe("FIFO topic");
  });

  it('FifoTopic string "true" is treated as FIFO', () => {
    const items = snsPricingDecomposer.decompose({ FifoTopic: "true" });

    expect(items).toHaveLength(2);
    const publishes = items.find((i) => i.label === "Publishes")!;
    expect(publishes.description).toBe("FIFO topic");
  });

  it("detects FIFO when TopicName ends in .fifo", () => {
    const items = snsPricingDecomposer.decompose({
      TopicName: "my-topic.fifo",
    });

    const publishes = items.find((i) => i.label === "Publishes")!;
    expect(publishes.description).toBe("FIFO topic");
  });

  it("standard topic has Standard topic description", () => {
    const items = snsPricingDecomposer.decompose({});

    const publishes = items.find((i) => i.label === "Publishes")!;
    expect(publishes.description).toBe("Standard topic");
  });

  it("all items are usage_based with quantity 0", () => {
    const standard = snsPricingDecomposer.decompose({});
    const fifo = snsPricingDecomposer.decompose({ FifoTopic: true });

    for (const item of [...standard, ...fifo]) {
      expect(item.kind).toBe("usage_based");
      expect(item.quantity).toBe(0);
    }
  });

  it("all filters use TERM_MATCH type", () => {
    const standard = snsPricingDecomposer.decompose({});
    const fifo = snsPricingDecomposer.decompose({ FifoTopic: true });

    for (const item of [...standard, ...fifo]) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("empty desiredState works", () => {
    const items = snsPricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("Publishes");
  });

  // EPIC-106-SNS: verify corrected filter shapes match real Pricing API shape

  it("Publishes line uses productFamily=API Request + group=SNS-Requests-Tier1", () => {
    const items = snsPricingDecomposer.decompose({});
    const publishes = items.find((i) => i.label === "Publishes")!;

    expect(publishes.filters).toContainEqual({
      Field: "productFamily",
      Value: "API Request",
      Type: "TERM_MATCH",
    });
    expect(publishes.filters).toContainEqual({
      Field: "group",
      Value: "SNS-Requests-Tier1",
      Type: "TERM_MATCH",
    });
    // Must NOT use Message Delivery (wrong product family for publishes)
    expect(publishes.filters).not.toContainEqual(
      expect.objectContaining({ Value: "Message Delivery" }),
    );
    // Must NOT use region-prefixed usagetype filter
    expect(publishes.filters).not.toContainEqual(
      expect.objectContaining({ Field: "usagetype" }),
    );
  });

  it("HTTP notifications line uses productFamily=Message Delivery + group=SNS-HTTP (not usagetype)", () => {
    const items = snsPricingDecomposer.decompose({});
    const http = items.find((i) => i.label === "HTTP notifications")!;

    expect(http.filters).toContainEqual({
      Field: "productFamily",
      Value: "Message Delivery",
      Type: "TERM_MATCH",
    });
    expect(http.filters).toContainEqual({
      Field: "group",
      Value: "SNS-HTTP",
      Type: "TERM_MATCH",
    });
    // Must NOT use unprefixed usagetype (returns zero matches in real API)
    expect(http.filters).not.toContainEqual(
      expect.objectContaining({ Field: "usagetype" }),
    );
  });

  it("snsPublishes mock fixture has correct productFamily and group", () => {
    // Validates that the mock fixture matches the filter shape the decomposer sends
    const parsed = JSON.parse(
      (snsPublishes.success as { text: string }).text,
    ) as {
      data: Array<{
        product: { productFamily: string; attributes: { group: string } };
      }>;
    };
    const product = parsed.data[0]!.product;

    expect(product.productFamily).toBe("API Request");
    expect(product.attributes.group).toBe("SNS-Requests-Tier1");
  });

  it("snsHttpDelivery mock fixture has correct productFamily and group", () => {
    // Validates that the HTTP delivery mock fixture matches the filter shape
    const parsed = JSON.parse(
      (snsHttpDelivery.success as { text: string }).text,
    ) as {
      data: Array<{
        product: {
          productFamily: string;
          attributes: { group: string; usagetype: string };
        };
      }>;
    };
    const product = parsed.data[0]!.product;

    expect(product.productFamily).toBe("Message Delivery");
    expect(product.attributes.group).toBe("SNS-HTTP");
    // usagetype in fixture is region-prefixed — demonstrates why group is used
    expect(product.attributes.usagetype).toBe("USE1-DeliveryAttempts-HTTP");
  });
});
