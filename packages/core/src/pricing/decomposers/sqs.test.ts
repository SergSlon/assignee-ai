/**
 * Tests for SQS pricing decomposer (Story 23.3).
 * Verifies line item generation for Standard and FIFO queues.
 */

import { describe, it, expect } from "vitest";
import { sqsPricingDecomposer } from "./sqs.js";

describe("sqsPricingDecomposer", () => {
  it("has correct resourceType", () => {
    expect(sqsPricingDecomposer.resourceType).toBe("AWS::SQS::Queue");
  });

  it("returns 1 standard item by default", () => {
    const items = sqsPricingDecomposer.decompose({});

    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Requests");
    expect(items[0]!.description).toBe("Standard queue");
  });

  it("returns FIFO item when FifoQueue is true", () => {
    const items = sqsPricingDecomposer.decompose({ FifoQueue: true });

    expect(items).toHaveLength(1);
    expect(items[0]!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "FIFO Queue",
        }),
      ]),
    );
    expect(items[0]!.description).toBe("FIFO queue");
  });

  it("returns FIFO item when FifoQueue is string true", () => {
    const items = sqsPricingDecomposer.decompose({ FifoQueue: "true" });
    expect(items[0]!.description).toBe("FIFO queue");
  });

  it("returns standard item when FifoQueue is false", () => {
    const items = sqsPricingDecomposer.decompose({ FifoQueue: false });

    expect(items).toHaveLength(1);
    expect(items[0]!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "Queue",
        }),
      ]),
    );
    expect(items[0]!.description).toBe("Standard queue");
  });

  it("detects FIFO when QueueName ends in .fifo", () => {
    const items = sqsPricingDecomposer.decompose({
      QueueName: "my-queue.fifo",
    });

    expect(items[0]!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "FIFO Queue",
        }),
      ]),
    );
    expect(items[0]!.description).toBe("FIFO queue");
  });

  it("all items are usage_based", () => {
    const standard = sqsPricingDecomposer.decompose({});
    const fifo = sqsPricingDecomposer.decompose({ FifoQueue: true });

    for (const item of [...standard, ...fifo]) {
      expect(item.kind).toBe("usage_based");
      expect(item.quantity).toBe(0);
    }
  });

  it("all filters use TERM_MATCH type", () => {
    const standard = sqsPricingDecomposer.decompose({});
    const fifo = sqsPricingDecomposer.decompose({ FifoQueue: true });

    for (const item of [...standard, ...fifo]) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("empty desiredState works", () => {
    const items = sqsPricingDecomposer.decompose({});

    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Requests");
  });
});
