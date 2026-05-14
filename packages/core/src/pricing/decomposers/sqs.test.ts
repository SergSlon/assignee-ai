/**
 * Tests for SQS pricing decomposer (Story 23.3 + PD-3 probe variations).
 *
 * PD-3 probe plan (≥3 distinct edge cases):
 *   A — Standard queue, us-east-1: Requests + DTO render non-null dollar amounts.
 *   B — Standard queue, eu-west-1: same assertion, EU fixture data.
 *   C — FIFO queue: FIFO-specific pricing (different rate, queueType=FIFO filter).
 *   D — Unsupported region (empty MCP response): graceful fallback, no crash.
 *   E — Cache-poisoning regression: service_name mismatch → reject + delete.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { sqsPricingDecomposer } from "./sqs.js";
import { extractFirstTierPrice } from "../mcp-parser.js";
import type { AwsPricingResponse } from "../types.js";
import {
  sqsStandardRequests,
  sqsStandardRequestsEu,
  sqsFifoRequests,
  sqsDataTransferOut,
  sqsEmptyResponse,
} from "../../test-fixtures/mcp-mock-responses/pricing-sqs.js";

// ── Helper: parse an mcpText fixture into an AwsPricingResponse ──────────────

function parseMcpFixture(fixture: {
  type: "text";
  text: string;
}): AwsPricingResponse {
  return JSON.parse(fixture.text) as AwsPricingResponse;
}

// ── Original structural tests (preserved from Story 23.3) ───────────────────

describe("sqsPricingDecomposer — structural (Story 23.3)", () => {
  it("has correct resourceType", () => {
    expect(sqsPricingDecomposer.resourceType).toBe("AWS::SQS::Queue");
  });

  it("returns 2 line items (Requests + Data transfer out) by default", () => {
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
    // PD-3 fix: productFamily is now "API Request" (not "FIFO Queue")
    expect(items[0]!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "API Request",
        }),
        expect.objectContaining({
          Field: "queueType",
          Value: "FIFO",
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
    // PD-3 fix: productFamily is now "API Request" (not "Queue")
    expect(items[0]!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "API Request",
        }),
        expect.objectContaining({
          Field: "queueType",
          Value: "Standard",
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
          Value: "API Request",
        }),
        expect.objectContaining({
          Field: "queueType",
          Value: "FIFO",
        }),
      ]),
    );
    expect(items[0]!.description).toBe("FIFO queue");
  });

  describe("Requests line item (PD-3 filter fix)", () => {
    it("uses productFamily=API Request (NOT 'Queue') — fix for Pricing API mismatch", () => {
      // PD-3 root cause: the old filter was productFamily='Queue' which
      // returns zero results from the AWS Pricing API. The real attribute
      // is 'API Request' (confirmed via fixture sqsStandardRequests).
      const items = sqsPricingDecomposer.decompose({});
      const req = items[0]!;
      expect(req.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Field: "productFamily",
            Value: "API Request",
          }),
        ]),
      );
      expect(req.filters).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ Value: "Queue" })]),
      );
      expect(req.filters).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Value: "FIFO Queue" }),
        ]),
      );
    });

    it("standard queue has queueType=Standard discriminator filter", () => {
      const items = sqsPricingDecomposer.decompose({});
      expect(items[0]!.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Field: "queueType", Value: "Standard" }),
        ]),
      );
    });

    it("FIFO queue has queueType=FIFO discriminator filter", () => {
      const items = sqsPricingDecomposer.decompose({ FifoQueue: true });
      expect(items[0]!.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Field: "queueType", Value: "FIFO" }),
        ]),
      );
    });

    it("serviceCode is AmazonSQS", () => {
      const items = sqsPricingDecomposer.decompose({});
      expect(items[0]!.serviceCode).toBe("AmazonSQS");
    });

    it("scale=1_000_000 and priceUnit=/M reqs", () => {
      const items = sqsPricingDecomposer.decompose({});
      const req = items[0]!;
      expect(req.scale).toBe(1_000_000);
      expect(req.priceUnit).toMatch(/M\s*reqs|million/i);
    });
  });

  describe("data transfer out line (PD-3 service-code fix)", () => {
    it("uses serviceCode=AWSDataTransfer (NOT AmazonSQS) — fix for Pricing API mismatch", () => {
      // PD-3 root cause 2: the old DTO line used serviceCode=AmazonSQS +
      // productFamily=Data Transfer — that combination returns zero results.
      // Data transfer is always billed via AWSDataTransfer (same as S3/EC2).
      const [, dto] = sqsPricingDecomposer.decompose({});
      expect(dto!.serviceCode).toBe("AWSDataTransfer");
      expect(dto!.serviceCode).not.toBe("AmazonSQS");
    });

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

    it("has proper AWSDataTransfer filters matching S3 DTO pattern", () => {
      const [, dto] = sqsPricingDecomposer.decompose({});
      expect(dto!.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Field: "productFamily",
            Value: "Data Transfer",
          }),
          expect.objectContaining({
            Field: "fromLocationType",
            Value: "AWS Region",
          }),
          expect.objectContaining({
            Field: "toLocationType",
            Value: "Other",
          }),
          expect.objectContaining({
            Field: "transferType",
            Value: "AWS Outbound",
          }),
        ]),
      );
    });

    it("description makes the cross-region caveat explicit", () => {
      // The advisor relies on this phrase to attach its
      // "only cross-region consumers" reminder at plan time.
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

// ── PD-3 Probe Variations ──────────────────────────────────────────────────

/**
 * These tests simulate the full pricing resolution path:
 *   decomposer → line-item filters → extractFirstTierPrice(fixture, ...)
 * They assert that the fixed filters produce non-null dollar amounts
 * from real fixture data — which is the failure mode that showed as
 * "unavailable" before PD-3.
 */
describe("PD-3 Probe Variation A — Standard queue, us-east-1", () => {
  it("Requests line item resolves to a non-null dollar rate from us-east-1 fixture", () => {
    const items = sqsPricingDecomposer.decompose({ QueueName: "genai-jobs" });
    const req = items.find((i) => i.label === "Requests")!;
    expect(req).toBeDefined();

    const data = parseMcpFixture(sqsStandardRequests.success);
    const price = extractFirstTierPrice(
      data,
      req.priceUnit,
      req.scale,
      req.filters,
    );

    // Must NOT be null — pre-fix this was null because productFamily="Queue"
    // matched nothing. Post-fix productFamily="API Request" + queueType="Standard"
    // matches exactly one SKU in the fixture.
    expect(price).not.toBeNull();
    expect(price).toMatch(/^\$\d+\.\d+/); // e.g. "$0.4000/M reqs"
    expect(price).not.toContain("unavailable");
  });

  it("Data transfer out line item resolves to a non-null dollar rate from AWSDataTransfer fixture", () => {
    const items = sqsPricingDecomposer.decompose({ QueueName: "genai-jobs" });
    const dto = items.find((i) => i.label === "Data transfer out")!;
    expect(dto).toBeDefined();

    // AWSDataTransfer fixture mirrors the S3 DTO fixture shape (same service).
    const data = parseMcpFixture(sqsDataTransferOut.success);
    const price = extractFirstTierPrice(
      data,
      dto.priceUnit,
      dto.scale,
      dto.filters,
    );

    // beginRange="1" means the first tier starts at 1GB (free tier below).
    // extractFirstTierPrice accepts beginRange ≤ 100, so "1" passes.
    expect(price).not.toBeNull();
    expect(price).toMatch(/^\$\d+\.\d+/); // e.g. "$0.0900/GB"
    expect(price).not.toContain("unavailable");
  });

  it('does NOT produce "unavailable" for either line item (closure criterion)', () => {
    const items = sqsPricingDecomposer.decompose({ QueueName: "genai-jobs" });

    const req = items.find((i) => i.label === "Requests")!;
    const dto = items.find((i) => i.label === "Data transfer out")!;

    const reqPrice = extractFirstTierPrice(
      parseMcpFixture(sqsStandardRequests.success),
      req.priceUnit,
      req.scale,
      req.filters,
    );
    const dtoPrice = extractFirstTierPrice(
      parseMcpFixture(sqsDataTransferOut.success),
      dto.priceUnit,
      dto.scale,
      dto.filters,
    );

    expect(reqPrice).not.toBeNull();
    expect(dtoPrice).not.toBeNull();
    // Neither is the string "unavailable"
    expect(reqPrice).not.toBe("unavailable");
    expect(dtoPrice).not.toBe("unavailable");
  });
});

describe("PD-3 Probe Variation B — Standard queue, eu-west-1", () => {
  it("Requests line item resolves from EU fixture (same rate, different regionCode)", () => {
    const items = sqsPricingDecomposer.decompose({ QueueName: "eu-queue" });
    const req = items.find((i) => i.label === "Requests")!;
    expect(req).toBeDefined();

    const data = parseMcpFixture(sqsStandardRequestsEu.success);
    const price = extractFirstTierPrice(
      data,
      req.priceUnit,
      req.scale,
      req.filters,
    );

    expect(price).not.toBeNull();
    expect(price).toMatch(/^\$\d+\.\d+/);
  });

  it("decomposer emits correct filters regardless of AWS_REGION (decomposer is region-agnostic)", () => {
    // The decomposer itself is stateless re: region — breakdown.ts injects
    // the region via the MCP call parameter. Asserting the filters are the
    // same for a eu-west-1 intent as for us-east-1.
    const usItems = sqsPricingDecomposer.decompose({ QueueName: "us-queue" });
    const euItems = sqsPricingDecomposer.decompose({ QueueName: "eu-queue" });

    // Structural parity — only the queue name differs
    expect(euItems[0]!.filters).toEqual(usItems[0]!.filters);
    expect(euItems[1]!.filters).toEqual(usItems[1]!.filters);
  });
});

describe("PD-3 Probe Variation C — FIFO queue", () => {
  it("FIFO Requests line item resolves from FIFO fixture (higher rate: $0.50/M)", () => {
    const items = sqsPricingDecomposer.decompose({
      QueueName: "order-processing.fifo",
      FifoQueue: true,
    });
    const req = items.find((i) => i.label === "Requests")!;
    expect(req).toBeDefined();

    const data = parseMcpFixture(sqsFifoRequests.success);
    const price = extractFirstTierPrice(
      data,
      req.priceUnit,
      req.scale,
      req.filters,
    );

    expect(price).not.toBeNull();
    expect(price).toMatch(/^\$\d+\.\d+/);

    // FIFO fixture has $0.0000005000/request → ×1M = $0.5000
    // Standard fixture has $0.0000004000/request → ×1M = $0.4000
    // Verify FIFO gives a higher rate than standard by cross-checking.
    const stdItems = sqsPricingDecomposer.decompose({});
    const stdPrice = extractFirstTierPrice(
      parseMcpFixture(sqsStandardRequests.success),
      stdItems[0]!.priceUnit,
      stdItems[0]!.scale,
      stdItems[0]!.filters,
    );

    // Both non-null; FIFO rate > standard rate (parsed numerically)
    expect(stdPrice).not.toBeNull();
    const fifoVal = parseFloat(price!.replace(/[$,]/g, ""));
    const stdVal = parseFloat(stdPrice!.replace(/[$,]/g, ""));
    expect(fifoVal).toBeGreaterThan(stdVal);
  });

  it("FIFO filter does NOT match standard queue fixture (cross-contamination guard)", () => {
    // Assert that the FIFO queueType filter correctly excludes the
    // standard-queue SKU — no price should come back.
    const items = sqsPricingDecomposer.decompose({ FifoQueue: true });
    const req = items.find((i) => i.label === "Requests")!;

    // Feed standard fixture data to FIFO filters — must return null because
    // the standard fixture's queueType=Standard doesn't match queueType=FIFO.
    const stdData = parseMcpFixture(sqsStandardRequests.success);
    const price = extractFirstTierPrice(
      stdData,
      req.priceUnit,
      req.scale,
      req.filters,
    );
    expect(price).toBeNull();
  });

  it("standard filter does NOT match FIFO fixture (inverse cross-contamination guard)", () => {
    const items = sqsPricingDecomposer.decompose({ FifoQueue: false });
    const req = items.find((i) => i.label === "Requests")!;

    const fifoData = parseMcpFixture(sqsFifoRequests.success);
    const price = extractFirstTierPrice(
      fifoData,
      req.priceUnit,
      req.scale,
      req.filters,
    );
    expect(price).toBeNull();
  });
});

describe("PD-3 Probe Variation D — unsupported/obscure region (graceful fallback)", () => {
  it("extractFirstTierPrice returns null (not crash) for empty MCP response", () => {
    const items = sqsPricingDecomposer.decompose({});
    const req = items[0]!;

    // Empty data array simulates the Pricing MCP returning no results for
    // an obscure region. The caller (breakdown.ts) sees null → sets
    // displayPrice="unavailable" — graceful, no exception thrown.
    const emptyData = parseMcpFixture(sqsEmptyResponse.success);
    expect(() => {
      const price = extractFirstTierPrice(
        emptyData,
        req.priceUnit,
        req.scale,
        req.filters,
      );
      expect(price).toBeNull(); // Graceful null — not a throw
    }).not.toThrow();
  });

  it("decomposer itself does not throw for any desiredState shape", () => {
    const badInputs = [
      {},
      { FifoQueue: true },
      { FifoQueue: "true" },
      { QueueName: null },
      { QueueName: 123 },
      { FifoQueue: undefined },
    ];
    for (const input of badInputs) {
      expect(() =>
        sqsPricingDecomposer.decompose(input as Record<string, unknown>),
      ).not.toThrow();
    }
  });
});

// ── PD-3 Probe Variation E — Cache-poisoning regression ────────────────────

describe("PD-3 Probe Variation E — cache-poisoning guard (service_name mismatch)", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    homeDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "assignee-sqs-bodyguard-"),
    );
    originalHome = process.env["HOME"];
    originalUserProfile = process.env["USERPROFILE"];
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env["USERPROFILE"];
    } else {
      process.env["USERPROFILE"] = originalUserProfile;
    }
    await fsPromises
      .rm(homeDir, { recursive: true, force: true })
      .catch(() => {});
  });

  /**
   * Write a cache entry whose body's `service_name` is set to `serviceName`
   * but is stored under the key for `requestedServiceCode + filters`.
   * Mirrors the manual-write pattern in price-cache.test.ts (Layer 3 block).
   */
  function writePoisonedCacheEntry(
    requestedServiceCode: string,
    filters: unknown[],
    poisonServiceName: string,
    cacheDir: string,
  ): string {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const safe = requestedServiceCode.replace(/[^a-zA-Z0-9_-]/g, "");
    const key = JSON.stringify({ serviceCode: requestedServiceCode, filters });
    const hash = crypto
      .createHash("sha256")
      .update(key)
      .digest("hex")
      .slice(0, 32);
    const fileName = `${safe}-${hash}.json`;
    const filePath = path.join(cacheDir, fileName);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        cachedAt: Date.now(),
        data: {
          status: "success",
          service_name: poisonServiceName, // ← mismatch
          data: [
            {
              product: { productFamily: "Storage", attributes: {} },
              terms: {
                OnDemand: {
                  "T1.JR": {
                    priceDimensions: {
                      "T1.JR.DIM": {
                        beginRange: "0",
                        pricePerUnit: { USD: "0.023" },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
        serviceCode: requestedServiceCode,
        filtersHash: hash,
      }),
      { mode: 0o600 },
    );
    return fileName;
  }

  it("getCachedPrice rejects + deletes an AmazonSNS-poisoned entry stored under AmazonSQS key", async () => {
    vi.resetModules();
    const { getCachedPrice } = await import("../../services/price-cache.js");

    const requestedServiceCode = "AmazonSQS";
    const filters = [
      { Type: "TERM_MATCH", Field: "productFamily", Value: "API Request" },
      { Type: "TERM_MATCH", Field: "queueType", Value: "Standard" },
    ];

    const cacheDir = path.join(homeDir, ".assignee", "cache", "pricing");
    const fileName = writePoisonedCacheEntry(
      requestedServiceCode,
      filters,
      "AmazonSNS", // ← poisoned with wrong service name
      cacheDir,
    );

    // Pre-condition: poisoned file exists
    expect(fs.readdirSync(cacheDir)).toContain(fileName);

    // Action: lookup
    const got = getCachedPrice(requestedServiceCode, filters);

    // Assertion 1: returns null (treated as miss)
    expect(got).toBeNull();

    // Assertion 2: stale file deleted from disk
    expect(fs.readdirSync(cacheDir)).not.toContain(fileName);
  });

  it("getCachedPrice accepts valid AmazonSQS entry whose service_name matches", async () => {
    vi.resetModules();
    const { setCachedPrice, getCachedPrice } =
      await import("../../services/price-cache.js");

    const serviceCode = "AmazonSQS";
    const filters = [
      { Type: "TERM_MATCH", Field: "productFamily", Value: "API Request" },
      { Type: "TERM_MATCH", Field: "queueType", Value: "Standard" },
    ];
    const validBody = {
      status: "success",
      service_name: "AmazonSQS", // ← matches
      data: [],
    };

    setCachedPrice(serviceCode, filters, validBody);
    const got = getCachedPrice(serviceCode, filters);

    // Round-trips unchanged — guard only fires on mismatch
    expect(got).toEqual(validBody);
  });
});
