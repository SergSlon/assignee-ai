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

  it("returns 2 line items (Requests + Data transfer out) by default", () => {
    // (f) 2026-04-09: SQS decomposer extended to emit a data-transfer-out
    // line alongside the headline Requests line, matching the plan-box
    // shape of other request-based services.
    const items = sqsPricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("Requests");
    expect(items[0]!.description).toBe("Standard queue");
    expect(items[1]!.label).toBe("Data transfer out");
    expect(items[1]!.description).toMatch(/cross-region/);
  });

  it("returns FIFO item + DTO when FifoQueue is true", () => {
    const items = sqsPricingDecomposer.decompose({ FifoQueue: true });

    expect(items).toHaveLength(2);
    expect(items[0]!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "FIFO Queue",
        }),
      ]),
    );
    expect(items[0]!.description).toBe("FIFO queue");
    expect(items[1]!.label).toBe("Data transfer out");
  });

  it("returns FIFO item when FifoQueue is string true", () => {
    const items = sqsPricingDecomposer.decompose({ FifoQueue: "true" });
    expect(items[0]!.description).toBe("FIFO queue");
  });

  it("returns standard item + DTO when FifoQueue is false", () => {
    const items = sqsPricingDecomposer.decompose({ FifoQueue: false });

    expect(items).toHaveLength(2);
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

  describe("data transfer out line (f) 2026-04-09", () => {
    it("is always present regardless of FIFO / standard", () => {
      const std = sqsPricingDecomposer.decompose({});
      const fifo = sqsPricingDecomposer.decompose({ FifoQueue: true });
      const named = sqsPricingDecomposer.decompose({
        QueueName: "legacy.fifo",
      });

      for (const items of [std, fifo, named]) {
        const dto = items.find((i) => i.label === "Data transfer out");
        expect(dto).toBeDefined();
      }
    });

    it("is USAGE_BASED with per-GB pricing", () => {
      const [, dto] = sqsPricingDecomposer.decompose({});
      expect(dto!.kind).toBe("usage_based");
      expect(dto!.unit).toBe("GB");
      expect(dto!.priceUnit).toBe("/GB");
    });

    it("queries the Data Transfer product family under the SC.SQS service code", () => {
      // SC.SQS = "AmazonSQS" in filter-constants.ts — single source
      // of truth. The mcp-advisor map was previously drifting to
      // "AWSQueueService" (caught in the (f) 2026-04-09 audit and
      // realigned).
      const [, dto] = sqsPricingDecomposer.decompose({});
      expect(dto!.serviceCode).toBe("AmazonSQS");
      expect(dto!.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Field: "productFamily",
            Value: "Data Transfer",
          }),
        ]),
      );
    });

    it("description makes the cross-region caveat explicit", () => {
      // The advisor relies on this phrase to attach its
      // "only cross-region consumers" reminder at plan time —
      // changing the text here without updating the advisor is
      // the regression we want to catch.
      const [, dto] = sqsPricingDecomposer.decompose({});
      expect(dto!.description).toMatch(/cross-region/i);
    });
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

  it("empty desiredState works (returns Requests + DTO)", () => {
    const items = sqsPricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("Requests");
    expect(items[1]!.label).toBe("Data transfer out");
  });
});
