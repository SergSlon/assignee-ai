/**
 * Tests for SNS pricing decomposer (Story 23.3).
 * Verifies line item generation for Standard and FIFO topics.
 */

import { describe, it, expect } from "vitest";
import { snsPricingDecomposer } from "./sns.js";

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
});
