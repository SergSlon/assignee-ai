/**
 * Unit tests for breakdown.ts bounded-concurrency pricing fan-out (M-α-21 / W13-S3).
 *
 * Covers:
 * 1. Max concurrency ≤ PRICING_CONCURRENCY for a 12-item input.
 * 2. Partial-failure isolation: one bad fetch does not abort the other items.
 * 3. All items fail → all results "unavailable"; hasPartialFailure = true.
 * 4. Zero line items → empty arrays, no errors.
 */

import { describe, it, expect, vi } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { PRICING_CONCURRENCY, queryLineItemPrices } from "./breakdown.js";
import type { PricingLineItem } from "@/index.js";
import { ToolName } from "@/constants/tools.js";

// ─── Silence price-cache filesystem I/O ─────────────────────────────────────
vi.mock("@/services/price-cache.js", () => ({
  getCachedPrice: vi.fn(() => null),
  setCachedPrice: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal AwsPricingResponse wrapped in MCP text envelope. */
function mcpPricingText(priceUsd: string): { type: "text"; text: string } {
  const sku = "TESTSKU001";
  return {
    type: "text",
    text: JSON.stringify({
      status: "success",
      service_name: "AmazonEC2",
      data: [
        {
          product: {
            productFamily: "Compute Instance",
            attributes: {
              regionCode: "us-east-1",
              servicecode: "AmazonEC2",
              instanceType: "t3.small",
              operatingSystem: "Linux",
              preInstalledSw: "NA",
              tenancy: "Shared",
              capacitystatus: "Used",
              licenseModel: "No License required",
            },
            sku,
          },
          terms: {
            OnDemand: {
              [`${sku}.JRTCKXETXF`]: {
                priceDimensions: {
                  [`${sku}.JRTCKXETXF.6YS6EN2CT7`]: {
                    unit: "Hrs",
                    endRange: "Inf",
                    description: "Linux On Demand Instance",
                    appliesTo: [],
                    rateCode: `${sku}.JRTCKXETXF.6YS6EN2CT7`,
                    beginRange: "0",
                    pricePerUnit: { USD: priceUsd },
                  },
                },
                sku,
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260223232215",
          publicationDate: "2026-02-23T23:22:15Z",
        },
      ],
      message: "Retrieved pricing from AWS Pricing API",
    }),
  };
}

/** Build a minimal fixed-kind PricingLineItem. */
function makeLineItem(index: number): PricingLineItem {
  return {
    label: `Compute ${index}`,
    quantity: 1,
    unit: "hours",
    serviceCode: "AmazonEC2",
    filters: [
      { Field: "instanceType", Value: "t3.small", Type: "TERM_MATCH" },
      { Field: "operatingSystem", Value: "Linux", Type: "TERM_MATCH" },
    ],
    kind: "fixed" as const,
    description: `t3.small #${index}`,
    priceUnit: "/hr",
  };
}

/** Build a mock StructuredTool that resolves with the given response. */
function makePricingTool(
  invokeFn: (input: unknown) => Promise<unknown>,
): StructuredTool {
  return {
    name: ToolName.GET_PRICING,
    invoke: invokeFn,
  } as unknown as StructuredTool;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PRICING_CONCURRENCY constant", () => {
  it("is exported and equals 5", () => {
    expect(PRICING_CONCURRENCY).toBe(5);
  });
});

describe("queryLineItemPrices — bounded concurrency", () => {
  it("never exceeds PRICING_CONCURRENCY concurrent calls for a 12-item input", async () => {
    const lineItems = Array.from({ length: 12 }, (_, i) => makeLineItem(i));

    let inFlight = 0;
    let maxInFlight = 0;

    // Each call increments counter, waits briefly, then decrements.
    const invokeFn = async (_input: unknown): Promise<unknown> => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Yield once to let other microtasks/promises queue up
      await Promise.resolve();
      inFlight--;
      return mcpPricingText("0.0416000000");
    };

    const tool = makePricingTool(invokeFn);
    const breakdown = await queryLineItemPrices(lineItems, [tool], "run-1");

    expect(maxInFlight).toBeLessThanOrEqual(PRICING_CONCURRENCY);
    expect(breakdown.fixedItems).toHaveLength(12);
  });

  it("processes all items in stable order", async () => {
    const count = 12;
    const lineItems = Array.from({ length: count }, (_, i) => makeLineItem(i));

    const invokeFn = async (_input: unknown): Promise<unknown> => {
      return mcpPricingText("0.0416000000");
    };

    const tool = makePricingTool(invokeFn);
    const breakdown = await queryLineItemPrices(lineItems, [tool], "run-order");

    // Results must preserve input ordering
    for (let i = 0; i < count; i++) {
      expect(breakdown.fixedItems[i]?.lineItem.label).toBe(`Compute ${i}`);
    }
  });
});

describe("queryLineItemPrices — partial-failure isolation", () => {
  it("one failing item does not abort remaining items; hasPartialFailure=true", async () => {
    const lineItems = Array.from({ length: 5 }, (_, i) => makeLineItem(i));

    // Item index 2 throws; others succeed.
    let callCount = 0;
    const invokeFn = async (_input: unknown): Promise<unknown> => {
      const index = callCount++;
      if (index === 2) {
        throw new Error("HTTP 429 Too Many Requests");
      }
      return mcpPricingText("0.0416000000");
    };

    const tool = makePricingTool(invokeFn);
    const breakdown = await queryLineItemPrices(
      lineItems,
      [tool],
      "run-partial",
    );

    expect(breakdown.hasPartialFailure).toBe(true);
    // All 5 items must be present (none dropped)
    expect(breakdown.fixedItems).toHaveLength(5);
    // Item 2 is "unavailable"; all others have a real price
    const unavailableItems = breakdown.fixedItems.filter(
      (r) => r.displayPrice === "unavailable",
    );
    const priceItems = breakdown.fixedItems.filter(
      (r) => r.displayPrice !== "unavailable",
    );
    expect(unavailableItems).toHaveLength(1);
    expect(priceItems).toHaveLength(4);
    expect(unavailableItems[0]?.lineItem.label).toBe("Compute 2");
  });

  it("all items failing → all results unavailable; hasPartialFailure=true", async () => {
    const lineItems = Array.from({ length: 3 }, (_, i) => makeLineItem(i));

    const invokeFn = async (_input: unknown): Promise<unknown> => {
      throw new Error("Service unavailable");
    };

    const tool = makePricingTool(invokeFn);
    const breakdown = await queryLineItemPrices(
      lineItems,
      [tool],
      "run-all-fail",
    );

    expect(breakdown.hasPartialFailure).toBe(true);
    expect(breakdown.fixedItems).toHaveLength(3);
    expect(
      breakdown.fixedItems.every((r) => r.displayPrice === "unavailable"),
    ).toBe(true);
    expect(
      breakdown.fixedItems.every(
        (r) => r.unitPrice === null && r.monthlyCost === null,
      ),
    ).toBe(true);
  });
});

describe("queryLineItemPrices — edge cases", () => {
  it("zero line items → empty breakdown with no errors", async () => {
    const tool = makePricingTool(async () => mcpPricingText("0.0416000000"));
    const breakdown = await queryLineItemPrices([], [tool], "run-empty");

    expect(breakdown.fixedItems).toHaveLength(0);
    expect(breakdown.usageBasedItems).toHaveLength(0);
    expect(breakdown.hasPartialFailure).toBe(false);
    expect(breakdown.hasCacheHits).toBe(false);
    expect(breakdown.fixedSubtotal).toBe(0);
  });

  it("no pricing tool → all items unavailable; hasPartialFailure=true", async () => {
    const lineItems = Array.from({ length: 3 }, (_, i) => makeLineItem(i));

    // Pass an empty tools array so pricingTool is undefined
    const breakdown = await queryLineItemPrices(lineItems, [], "run-notool");

    expect(breakdown.hasPartialFailure).toBe(true);
    expect(breakdown.fixedItems).toHaveLength(3);
    expect(
      breakdown.fixedItems.every((r) => r.displayPrice === "unavailable"),
    ).toBe(true);
  });
});

describe("queryLineItemPrices — AWSDataTransfer fromRegionCode injection", () => {
  // Bug: S3 / EC2 / API Gateway data-transfer-out lines were rendering as
  // `unavailable` because the AWSDataTransfer service code returns rows
  // for EVERY region (us-east-1, us-east-2, eu-west-1, …) when the
  // request doesn't filter by `fromRegionCode`. The MCP tool's `region`
  // parameter does NOT scope the filter for AWSDataTransfer (it does
  // for service-specific codes like AmazonS3 / AmazonEC2). This block
  // verifies breakdown.ts injects `fromRegionCode=<AWS_REGION>` into
  // any AWSDataTransfer request that doesn't already specify it.
  it("injects fromRegionCode=<region> for AWSDataTransfer requests", async () => {
    const captured: Array<{
      filters: ReadonlyArray<{ Field: string; Value: string; Type: string }>;
    }> = [];
    const tool = makePricingTool(async (input) => {
      captured.push(
        input as {
          filters: ReadonlyArray<{
            Field: string;
            Value: string;
            Type: string;
          }>;
        },
      );
      return mcpPricingText("0.0900000000");
    });

    const dataTransferItem: PricingLineItem = {
      label: "Data transfer out",
      quantity: 0,
      unit: "GB",
      serviceCode: "AWSDataTransfer",
      filters: [
        { Field: "productFamily", Value: "Data Transfer", Type: "TERM_MATCH" },
        { Field: "transferType", Value: "AWS Outbound", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per GB",
      priceUnit: "per GB",
    };

    await queryLineItemPrices([dataTransferItem], [tool], "run-dtx");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.filters.some((f) => f.Field === "fromRegionCode")).toBe(
      true,
    );
  });

  it("does NOT mutate filters for non-AWSDataTransfer service codes", async () => {
    const captured: Array<{
      filters: ReadonlyArray<{ Field: string; Value: string; Type: string }>;
    }> = [];
    const tool = makePricingTool(async (input) => {
      captured.push(
        input as {
          filters: ReadonlyArray<{
            Field: string;
            Value: string;
            Type: string;
          }>;
        },
      );
      return mcpPricingText("0.0230000000");
    });

    const s3StorageItem: PricingLineItem = {
      label: "Storage",
      quantity: 0,
      unit: "GB",
      serviceCode: "AmazonS3",
      filters: [
        { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per GB-month",
      priceUnit: "per GB-month",
    };

    await queryLineItemPrices([s3StorageItem], [tool], "run-s3");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.filters.some((f) => f.Field === "fromRegionCode")).toBe(
      false,
    );
  });

  it("preserves an existing fromRegionCode filter (idempotent)", async () => {
    const captured: Array<{
      filters: ReadonlyArray<{ Field: string; Value: string; Type: string }>;
    }> = [];
    const tool = makePricingTool(async (input) => {
      captured.push(
        input as {
          filters: ReadonlyArray<{
            Field: string;
            Value: string;
            Type: string;
          }>;
        },
      );
      return mcpPricingText("0.0900000000");
    });

    const dataTransferItem: PricingLineItem = {
      label: "Data transfer out",
      quantity: 0,
      unit: "GB",
      serviceCode: "AWSDataTransfer",
      filters: [
        { Field: "fromRegionCode", Value: "eu-west-1", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per GB",
      priceUnit: "per GB",
    };

    await queryLineItemPrices([dataTransferItem], [tool], "run-dtx-prefilled");

    expect(captured).toHaveLength(1);
    const fromRegion = captured[0]!.filters.filter(
      (f) => f.Field === "fromRegionCode",
    );
    expect(fromRegion).toHaveLength(1);
    // Pre-existing value preserved, not overwritten with AWS_REGION
    expect(fromRegion[0]!.Value).toBe("eu-west-1");
  });
});
