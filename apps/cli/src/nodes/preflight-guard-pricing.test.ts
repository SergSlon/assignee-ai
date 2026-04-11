/**
 * Integration tests for the S3 pricing decomposer flow.
 *
 * Validates that:
 * 1. The S3 decomposer produces the correct 4 line items
 * 2. queryLineItemPrices (via preflightGuardNode) dispatches by filters and
 *    returns DIFFERENT prices for each line item — not the same $0.023 for all
 * 3. extractFirstTierPrice returns null when filters don't match (not a wrong price)
 * 4. PricingBreakdown structure is correct (fixedItems/usageBasedItems split)
 * 5. Cache produces different keys for different filter sets
 *
 * @see Story 23.3, Story 23.6
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ExecutionStatus,
  defaultDecomposerRegistry,
  extractFirstTierPrice,
  type AwsPricingResponse,
  type McpPricingFilter,
} from "@assignee/core";
import { preflightGuardNode } from "./preflight-guard.js";
import { ToolName } from "../constants/tools.js";
import type { StructuredTool } from "@langchain/core/tools";

// ═══════════════════════════════════════════════════════════════════════════════
// Mock price-cache to avoid filesystem I/O in tests
// ═══════════════════════════════════════════════════════════════════════════════

const cacheStore = new Map<string, unknown>();

vi.mock("../services/price-cache.js", () => ({
  getCachedPrice: vi.fn((serviceCode: string, filters: unknown[]) => {
    const key = JSON.stringify({ serviceCode, filters });
    return cacheStore.get(key) ?? null;
  }),
  setCachedPrice: vi.fn(
    (serviceCode: string, filters: unknown[], data: unknown) => {
      const key = JSON.stringify({ serviceCode, filters });
      cacheStore.set(key, data);
    },
  ),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Mock free-tier to avoid filesystem access
// ═══════════════════════════════════════════════════════════════════════════════

vi.mock("../utils/free-tier.js", () => ({
  getFreeTierNote: vi.fn(() => undefined),
  loadAccountCreatedDate: vi.fn(() => undefined),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Realistic MCP response builders (based on captured responses)
// ═══════════════════════════════════════════════════════════════════════════════

function buildMcpPricingResponse(opts: {
  productFamily: string;
  attributes: Record<string, string>;
  sku: string;
  priceUsd: string;
  unit: string;
  beginRange?: string;
}): { type: "text"; text: string } {
  return {
    type: "text",
    text: JSON.stringify({
      status: "success",
      service_name: opts.attributes["servicecode"] ?? "AmazonS3",
      data: [
        {
          product: {
            productFamily: opts.productFamily,
            attributes: {
              regionCode: "us-east-1",
              ...opts.attributes,
            },
            sku: opts.sku,
          },
          terms: {
            OnDemand: {
              [`${opts.sku}.JRTCKXETXF`]: {
                priceDimensions: {
                  [`${opts.sku}.JRTCKXETXF.6YS6EN2CT7`]: {
                    unit: opts.unit,
                    endRange: "Inf",
                    description: `Price for ${opts.productFamily}`,
                    appliesTo: [],
                    rateCode: `${opts.sku}.JRTCKXETXF.6YS6EN2CT7`,
                    beginRange: opts.beginRange ?? "0",
                    pricePerUnit: { USD: opts.priceUsd },
                  },
                },
                sku: opts.sku,
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

/** S3 Storage: $0.0230/GB-Mo */
const s3StorageResponse = buildMcpPricingResponse({
  productFamily: "Storage",
  attributes: {
    usagetype: "TimedStorage-ByteHrs",
    servicecode: "AmazonS3",
    servicename: "Amazon Simple Storage Service",
  },
  sku: "WP9ANXZGBYYSGJEA",
  priceUsd: "0.0230000000",
  unit: "GB-Mo",
});

/** S3 PUT requests: $0.0050/1000 reqs */
const s3PutResponse = buildMcpPricingResponse({
  productFamily: "API Request",
  attributes: {
    usagetype: "Requests-Tier1",
    group: "S3-API-Tier1",
    servicecode: "AmazonS3",
    servicename: "Amazon Simple Storage Service",
  },
  sku: "S3PUTREQSKU0001",
  priceUsd: "0.0050000000",
  unit: "Requests",
});

/** S3 GET requests: $0.0004/1000 reqs */
const s3GetResponse = buildMcpPricingResponse({
  productFamily: "API Request",
  attributes: {
    usagetype: "Requests-Tier2",
    group: "S3-API-Tier2",
    servicecode: "AmazonS3",
    servicename: "Amazon Simple Storage Service",
  },
  sku: "S3GETREQSKU0001",
  priceUsd: "0.0004000000",
  unit: "Requests",
});

/** Data Transfer Out: $0.0900/GB */
const s3DataTransferResponse = buildMcpPricingResponse({
  productFamily: "Data Transfer",
  attributes: {
    usagetype: "DataTransfer-Out-Bytes",
    fromLocationType: "AWS Region",
    toLocationType: "Other",
    transferType: "AWS Outbound",
    servicecode: "AWSDataTransfer",
    servicename: "AWS Data Transfer",
  },
  sku: "DTOUTSKU000001",
  priceUsd: "0.0900000000",
  unit: "GB",
});

// ═══════════════════════════════════════════════════════════════════════════════
// Filter-dispatching mock tool
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a mock pricing tool that dispatches responses based on the filters
 * passed in the invocation args. This is the key fix for the bug where a
 * single static mock always returned $0.0230 for every line item.
 */
function createFilterDispatchedPricingTool(): StructuredTool {
  return {
    name: ToolName.GET_PRICING,
    description: "",
    invoke: vi
      .fn()
      .mockImplementation(
        (args: { service_code: string; filters: McpPricingFilter[] }) => {
          const filters = args.filters;

          // Storage: productFamily=Storage, usagetype=TimedStorage-ByteHrs
          if (
            filters.some(
              (f) => f.Field === "productFamily" && f.Value === "Storage",
            )
          ) {
            return Promise.resolve(s3StorageResponse);
          }

          // PUT requests: usagetype=Requests-Tier1
          if (
            filters.some(
              (f) => f.Field === "usagetype" && f.Value === "Requests-Tier1",
            )
          ) {
            return Promise.resolve(s3PutResponse);
          }

          // GET requests: usagetype=Requests-Tier2
          if (
            filters.some(
              (f) => f.Field === "usagetype" && f.Value === "Requests-Tier2",
            )
          ) {
            return Promise.resolve(s3GetResponse);
          }

          // Data Transfer: productFamily=Data Transfer
          if (
            filters.some(
              (f) => f.Field === "productFamily" && f.Value === "Data Transfer",
            )
          ) {
            return Promise.resolve(s3DataTransferResponse);
          }

          // Fallback: empty response
          return Promise.resolve({
            type: "text",
            text: JSON.stringify({ status: "success", data: [] }),
          });
        },
      ),
  } as unknown as StructuredTool;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an S3 bucket",
    runId: "run-pricing-test",
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "plan",
    resourceType: "AWS::S3::Bucket",
    resourceSchema: undefined,
    desiredState: undefined,
    estimatedMonthlyCost: undefined,
    requestToken: undefined,
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<typeof preflightGuardNode>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. S3 decomposer produces correct line items
// ═══════════════════════════════════════════════════════════════════════════════

describe("S3 pricing decomposer — line item structure", () => {
  const items = defaultDecomposerRegistry.decompose("AWS::S3::Bucket", {});

  it("produces exactly 4 line items", () => {
    expect(items).toHaveLength(4);
  });

  it("registry has S3 Bucket decomposer registered", () => {
    expect(defaultDecomposerRegistry.has("AWS::S3::Bucket")).toBe(true);
  });

  it("Storage item has correct serviceCode, filters, kind", () => {
    const storage = items.find((i) => i.label === "Storage")!;
    // Wave 17: strengthened — assert by label so a refactor that
    // renames the line item fails here.
    expect(storage?.label).toBe("Storage");
    expect(storage.serviceCode).toBe("AmazonS3");
    expect(storage.kind).toBe("usage_based");
    expect(storage.priceUnit).toBe("/GB-mo");
    expect(storage.filters).toEqual(
      expect.arrayContaining([
        { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
        {
          Field: "usagetype",
          Value: "TimedStorage-ByteHrs",
          Type: "TERM_MATCH",
        },
      ]),
    );
  });

  it("PUT requests item has correct filters and kind", () => {
    const put = items.find((i) => i.label === "PUT requests")!;
    // Wave 17: strengthened.
    expect(put?.label).toBe("PUT requests");
    expect(put.serviceCode).toBe("AmazonS3");
    expect(put.kind).toBe("usage_based");
    expect(put.priceUnit).toBe("/1000 reqs");
    expect(put.filters).toEqual(
      expect.arrayContaining([
        { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
        { Field: "usagetype", Value: "Requests-Tier1", Type: "TERM_MATCH" },
      ]),
    );
  });

  it("GET requests item has correct filters and kind", () => {
    const get = items.find((i) => i.label === "GET requests")!;
    // Wave 17: strengthened.
    expect(get?.label).toBe("GET requests");
    expect(get.serviceCode).toBe("AmazonS3");
    expect(get.kind).toBe("usage_based");
    expect(get.priceUnit).toBe("/1000 reqs");
    expect(get.filters).toEqual(
      expect.arrayContaining([
        { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
        { Field: "usagetype", Value: "Requests-Tier2", Type: "TERM_MATCH" },
      ]),
    );
  });

  it("Data transfer out item has correct serviceCode and filters", () => {
    const dt = items.find((i) => i.label === "Data transfer out")!;
    // Wave 17: strengthened.
    expect(dt?.label).toBe("Data transfer out");
    expect(dt.serviceCode).toBe("AWSDataTransfer");
    expect(dt.kind).toBe("usage_based");
    expect(dt.priceUnit).toBe("/GB");
    expect(dt.filters).toEqual(
      expect.arrayContaining([
        { Field: "productFamily", Value: "Data Transfer", Type: "TERM_MATCH" },
        { Field: "fromLocationType", Value: "AWS Region", Type: "TERM_MATCH" },
        { Field: "toLocationType", Value: "Other", Type: "TERM_MATCH" },
        { Field: "transferType", Value: "AWS Outbound", Type: "TERM_MATCH" },
      ]),
    );
  });

  it("all items have quantity 0 (usage-based, no default quantity)", () => {
    for (const item of items) {
      expect(item.quantity).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. queryLineItemPrices with filter-dispatched mock
//    Verifies each line item gets a DIFFERENT price (the original bug)
// ═══════════════════════════════════════════════════════════════════════════════

describe("S3 pricing — filter-dispatched queryLineItemPrices via preflightGuardNode", () => {
  it("returns different prices for each S3 line item (regression: all were $0.0230)", async () => {
    const pricingTool = createFilterDispatchedPricingTool();

    const result = await preflightGuardNode(makeState(), [pricingTool]);

    expect(result.preflightPassed).toBe(true);

    // The decomposer should have triggered 4 separate queries
    // (1 for the top-level pricing strategy + 4 for decomposer line items = 5 total)
    const invokeFn = pricingTool.invoke as ReturnType<typeof vi.fn>;
    // At least 4 calls for the decomposer line items
    expect(invokeFn.mock.calls.length).toBeGreaterThanOrEqual(4);

    // Verify the pricingBreakdown was returned. Wave 17: strengthened
    // — assert breakdown is a real object with the expected key
    // shape. The previous `toBeDefined()` would have passed for any
    // non-undefined value, including a string or number.
    const breakdown = result.pricingBreakdown;
    expect(typeof breakdown).toBe("object");
    expect(breakdown).not.toBeNull();
    expect(Array.isArray(breakdown!.usageBasedItems)).toBe(true);
    expect(Array.isArray(breakdown!.fixedItems)).toBe(true);

    // All S3 items are usage_based
    expect(breakdown!.usageBasedItems).toHaveLength(4);
    expect(breakdown!.fixedItems).toHaveLength(0);

    // Extract the unit prices
    const priceMap = new Map<string, string | null>();
    for (const item of breakdown!.usageBasedItems) {
      priceMap.set(item.lineItem.label, item.unitPrice);
    }

    // Each line item must have a DIFFERENT price — the core regression check
    expect(priceMap.get("Storage")).toBe("$0.0230/GB-mo");
    expect(priceMap.get("PUT requests")).toBe("$0.0050/1000 reqs");
    expect(priceMap.get("GET requests")).toBe("$0.0004/1000 reqs");
    expect(priceMap.get("Data transfer out")).toBe("$0.0900/GB");

    // Verify all 4 prices are distinct
    const uniquePrices = new Set(priceMap.values());
    expect(uniquePrices.size).toBe(4);
  });

  it("marks hasPartialFailure = false when all line items resolve", async () => {
    const pricingTool = createFilterDispatchedPricingTool();
    const result = await preflightGuardNode(makeState(), [pricingTool]);

    // Wave 17: strengthened — assert object shape, not just defined.
    expect(typeof result.pricingBreakdown).toBe("object");
    expect(result.pricingBreakdown).not.toBeNull();
    expect(result.pricingBreakdown!.hasPartialFailure).toBe(false);
  });

  it("marks hasPartialFailure = true when one line item returns empty data", async () => {
    // Create a tool that returns empty for Data Transfer queries
    const pricingTool = {
      name: ToolName.GET_PRICING,
      description: "",
      invoke: vi
        .fn()
        .mockImplementation((args: { filters: McpPricingFilter[] }) => {
          const filters = args.filters;

          if (
            filters.some(
              (f) => f.Field === "productFamily" && f.Value === "Storage",
            )
          ) {
            return Promise.resolve(s3StorageResponse);
          }
          if (
            filters.some(
              (f) => f.Field === "usagetype" && f.Value === "Requests-Tier1",
            )
          ) {
            return Promise.resolve(s3PutResponse);
          }
          if (
            filters.some(
              (f) => f.Field === "usagetype" && f.Value === "Requests-Tier2",
            )
          ) {
            return Promise.resolve(s3GetResponse);
          }

          // Data Transfer returns empty data — simulates MCP failure
          return Promise.resolve({
            type: "text",
            text: JSON.stringify({ status: "success", data: [] }),
          });
        }),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [pricingTool]);

    // Wave 17: strengthened — assert object shape, not just defined.
    expect(typeof result.pricingBreakdown).toBe("object");
    expect(result.pricingBreakdown).not.toBeNull();
    expect(result.pricingBreakdown!.hasPartialFailure).toBe(true);

    // 3 items priced, 1 unavailable
    const priced = result.pricingBreakdown!.usageBasedItems.filter(
      (i) => i.unitPrice !== null,
    );
    const unavailable = result.pricingBreakdown!.usageBasedItems.filter(
      (i) => i.unitPrice === null,
    );
    expect(priced).toHaveLength(3);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.lineItem.label).toBe("Data transfer out");
    expect(unavailable[0]!.displayPrice).toBe("unavailable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Fallback when MCP returns non-matching items
//    extractFirstTierPrice should return null (not a wrong price)
// ═══════════════════════════════════════════════════════════════════════════════

describe("extractFirstTierPrice — filter validation", () => {
  it("returns null when response item productFamily does not match filters", () => {
    // Response has Storage product, but filters ask for API Request
    const storageData: AwsPricingResponse = JSON.parse(s3StorageResponse.text);
    const apiRequestFilters: McpPricingFilter[] = [
      { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
      { Field: "usagetype", Value: "Requests-Tier1", Type: "TERM_MATCH" },
    ];

    const result = extractFirstTierPrice(
      storageData,
      "/1000 reqs",
      1,
      apiRequestFilters,
    );
    expect(result).toBeNull();
  });

  it("returns null when response item usagetype does not match filters", () => {
    // Response has Requests-Tier1 (PUT), but filters ask for Requests-Tier2 (GET)
    const putData: AwsPricingResponse = JSON.parse(s3PutResponse.text);
    const getFilters: McpPricingFilter[] = [
      { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
      { Field: "usagetype", Value: "Requests-Tier2", Type: "TERM_MATCH" },
    ];

    const result = extractFirstTierPrice(putData, "/1000 reqs", 1, getFilters);
    expect(result).toBeNull();
  });

  it("returns correct price when response matches filters", () => {
    const storageData: AwsPricingResponse = JSON.parse(s3StorageResponse.text);
    const storageFilters: McpPricingFilter[] = [
      { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
      {
        Field: "usagetype",
        Value: "TimedStorage-ByteHrs",
        Type: "TERM_MATCH",
      },
    ];

    const result = extractFirstTierPrice(
      storageData,
      "/GB-mo",
      1,
      storageFilters,
    );
    expect(result).toBe("$0.0230/GB-mo");
  });

  it("returns null for empty data array with filters", () => {
    const emptyData: AwsPricingResponse = { data: [] };
    const filters: McpPricingFilter[] = [
      { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
    ];

    const result = extractFirstTierPrice(emptyData, "/GB-mo", 1, filters);
    expect(result).toBeNull();
  });

  it("accepts item when productFamily matches but attributes are missing (lenient for real MCP)", () => {
    const noAttrData: AwsPricingResponse = {
      data: [
        {
          product: {
            productFamily: "Storage",
            // no attributes property
          },
          terms: {
            OnDemand: {
              "SKU.TERM": {
                priceDimensions: {
                  "SKU.TERM.DIM": {
                    beginRange: "0",
                    pricePerUnit: { USD: "0.0230" },
                  },
                },
              },
            },
          },
        },
      ],
    };
    const filters: McpPricingFilter[] = [
      { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
      {
        Field: "usagetype",
        Value: "TimedStorage-ByteHrs",
        Type: "TERM_MATCH",
      },
    ];

    const result = extractFirstTierPrice(noAttrData, "/GB-mo", 1, filters);
    // productFamily matches; missing attributes are treated as pass (lenient for sparse MCP responses)
    expect(result).toBe("$0.0230/GB-mo");
  });

  it("without expectedFilters, returns first beginRange=0 price (legacy behavior)", () => {
    const storageData: AwsPricingResponse = JSON.parse(s3StorageResponse.text);

    // No filters => legacy mode, picks first beginRange=0 item
    const result = extractFirstTierPrice(storageData, "/GB-mo");
    expect(result).toBe("$0.0230/GB-mo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PricingBreakdown structure
// ═══════════════════════════════════════════════════════════════════════════════

describe("PricingBreakdown structure", () => {
  it("correctly splits into fixedItems and usageBasedItems", async () => {
    const pricingTool = createFilterDispatchedPricingTool();
    const result = await preflightGuardNode(makeState(), [pricingTool]);

    const breakdown = result.pricingBreakdown!;
    // Wave 17: strengthened — assert object shape, not just defined.
    expect(typeof breakdown).toBe("object");
    expect(breakdown).not.toBeNull();

    // All S3 items are usage_based — no fixed items
    expect(breakdown.fixedItems).toHaveLength(0);
    expect(breakdown.usageBasedItems).toHaveLength(4);
    expect(breakdown.fixedSubtotal).toBe(0);
  });

  it("sets fetchedAt to a date string", async () => {
    const pricingTool = createFilterDispatchedPricingTool();
    const result = await preflightGuardNode(makeState(), [pricingTool]);

    expect(result.pricingBreakdown!.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("usage-based items have monthlyCost = null (no fixed cost)", async () => {
    const pricingTool = createFilterDispatchedPricingTool();
    const result = await preflightGuardNode(makeState(), [pricingTool]);

    for (const item of result.pricingBreakdown!.usageBasedItems) {
      expect(item.monthlyCost).toBeNull();
    }
  });

  it("usage-based items show per-unit price as displayPrice", async () => {
    const pricingTool = createFilterDispatchedPricingTool();
    const result = await preflightGuardNode(makeState(), [pricingTool]);

    const displayPrices = result.pricingBreakdown!.usageBasedItems.map(
      (i) => i.displayPrice,
    );

    expect(displayPrices).toContain("$0.0230/GB-mo");
    expect(displayPrices).toContain("$0.0050/1000 reqs");
    expect(displayPrices).toContain("$0.0004/1000 reqs");
    expect(displayPrices).toContain("$0.0900/GB");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Cache behavior — different filter hashes produce different cache keys
// ═══════════════════════════════════════════════════════════════════════════════

describe("Price cache — filter-based key differentiation", () => {
  it("caches each line item response separately (different filter sets)", async () => {
    const { setCachedPrice } = await import("../services/price-cache.js");
    const pricingTool = createFilterDispatchedPricingTool();

    await preflightGuardNode(makeState(), [pricingTool]);

    // setCachedPrice should have been called for each line item that was fetched
    const setCalls = (setCachedPrice as ReturnType<typeof vi.fn>).mock.calls;

    // At least 4 calls from the decomposer line items (possibly +1 from the top-level pricing query)
    expect(setCalls.length).toBeGreaterThanOrEqual(4);

    // Extract the {serviceCode, filters} pairs to verify uniqueness
    const cacheKeys = setCalls.map((call: unknown[]) =>
      JSON.stringify({ serviceCode: call[0], filters: call[1] }),
    );
    const uniqueKeys = new Set(cacheKeys);

    // Each cache key should be unique — different filters = different keys
    expect(uniqueKeys.size).toBe(cacheKeys.length);
  });

  it("uses cached response on second call (no duplicate MCP invocations)", async () => {
    const pricingTool = createFilterDispatchedPricingTool();

    // First call: populates cache
    await preflightGuardNode(makeState(), [pricingTool]);
    const firstCallCount = (pricingTool.invoke as ReturnType<typeof vi.fn>).mock
      .calls.length;

    // Second call: should use cache for decomposer items
    const pricingTool2 = createFilterDispatchedPricingTool();
    const result2 = await preflightGuardNode(makeState(), [pricingTool2]);

    // The second tool should have fewer invoke calls because cached items skip MCP
    const secondCallCount = (pricingTool2.invoke as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    // The decomposer line items should be cached, so at most 1 call for the
    // top-level pricing query (which uses a different code path without caching)
    expect(secondCallCount).toBeLessThan(firstCallCount);

    // Prices should still be correct from cache
    const breakdown = result2.pricingBreakdown!;
    // Wave 17: strengthened — assert object shape, not just defined.
    expect(typeof breakdown).toBe("object");
    expect(breakdown).not.toBeNull();

    const priceMap = new Map<string, string | null>();
    for (const item of breakdown.usageBasedItems) {
      priceMap.set(item.lineItem.label, item.unitPrice);
    }
    expect(priceMap.get("Storage")).toBe("$0.0230/GB-mo");
    expect(priceMap.get("PUT requests")).toBe("$0.0050/1000 reqs");
    expect(priceMap.get("GET requests")).toBe("$0.0004/1000 reqs");
    expect(priceMap.get("Data transfer out")).toBe("$0.0900/GB");
  });

  it("storage and PUT filters produce different cache keys", () => {
    const storageFilters: McpPricingFilter[] = [
      { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
      {
        Field: "usagetype",
        Value: "TimedStorage-ByteHrs",
        Type: "TERM_MATCH",
      },
    ];
    const putFilters: McpPricingFilter[] = [
      { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
      { Field: "usagetype", Value: "Requests-Tier1", Type: "TERM_MATCH" },
    ];

    const storageKey = JSON.stringify({
      serviceCode: "AmazonS3",
      filters: storageFilters,
    });
    const putKey = JSON.stringify({
      serviceCode: "AmazonS3",
      filters: putFilters,
    });

    expect(storageKey).not.toBe(putKey);
  });

  it("GET and PUT filters produce different cache keys despite same serviceCode", () => {
    const putFilters: McpPricingFilter[] = [
      { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
      { Field: "usagetype", Value: "Requests-Tier1", Type: "TERM_MATCH" },
    ];
    const getFilters: McpPricingFilter[] = [
      { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
      { Field: "usagetype", Value: "Requests-Tier2", Type: "TERM_MATCH" },
    ];

    const putKey = JSON.stringify({
      serviceCode: "AmazonS3",
      filters: putFilters,
    });
    const getKey = JSON.stringify({
      serviceCode: "AmazonS3",
      filters: getFilters,
    });

    expect(putKey).not.toBe(getKey);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Story 46.2 — DataSource attribution flowing through preflightGuardNode
// ═══════════════════════════════════════════════════════════════════════════════

describe("preflightGuardNode — DataSource attribution (Story 46.2)", () => {
  it('tags state.estimatedMonthlyCostSource = "mcp" when the live Pricing tool resolves a price', async () => {
    // Use the same filter-dispatched tool as the canonical S3 test above —
    // it returns real captured Pricing API responses, so the extracted
    // price is non-null and the source MUST be "mcp".
    const pricingTool = createFilterDispatchedPricingTool();

    const result = await preflightGuardNode(
      makeState({ resourceType: "AWS::S3::Bucket" }),
      [pricingTool],
    );

    // estimatedMonthlyCost is the headline string; estimatedMonthlyCostSource
    // tells the display layer whether to render "(live)" or "(estimated)".
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(result.estimatedMonthlyCostSource).toBe("mcp");
    // Blind Hunter wave-2 finding #11: assert the label is a real dollar
    // amount, not "N/A". A regression that flips the extractFirstTierPrice
    // null branch to return "mcp" would fool the previous source-only
    // assertion, but the dollar-amount check catches it.
    expect(result.estimatedMonthlyCost).toMatch(/^\$\d/);
  });

  it('tags estimatedMonthlyCostSource = "fallback" when the Pricing tool is missing entirely', async () => {
    // No tool array → preflight has no way to call the Pricing MCP, so
    // it must fall back to localEstimate which carries source "fallback"
    // for the S3 strategy (not "mcp").
    const result = await preflightGuardNode(
      makeState({ resourceType: "AWS::S3::Bucket" }),
      undefined,
    );

    expect(result.estimatedMonthlyCostSource).toBe("fallback");
  });

  it('tags estimatedMonthlyCostSource = "fallback" when the Pricing tool throws', async () => {
    // Blind Hunter wave-2 finding #3: the previous test couldn't tell
    // "tool was called and threw" apart from "tool was never called". We
    // now spy on `invoke` and assert it was actually invoked, so a
    // regression that bypasses the catch block (e.g. by short-circuiting
    // when mcpConfig is missing earlier) fails this test.
    const invokeSpy = vi.fn().mockRejectedValue(new Error("MCP unavailable"));
    const failingTool = {
      name: ToolName.GET_PRICING,
      description: "",
      invoke: invokeSpy,
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(
      makeState({ resourceType: "AWS::S3::Bucket" }),
      [failingTool],
    );

    // The error path falls back to localEstimate which is "fallback".
    expect(result.estimatedMonthlyCostSource).toBe("fallback");
    // The catch block MUST have run — invokeSpy was called at least once.
    expect(invokeSpy).toHaveBeenCalled();
  });

  it('tags estimatedMonthlyCostSource = "free" for a free-tier resource type (IAM Role)', async () => {
    // IAM Role has no MCP query (mcpConfig undefined) and the local
    // strategy returns source: "free". The preflight result must
    // preserve that — never "fallback", never "mcp".
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::IAM::Role",
        userIntent: "Create an IAM role",
      }),
      undefined,
    );

    expect(result.estimatedMonthlyCostSource).toBe("free");
  });
});
