/**
 * Coverage integration test — verifies every resource type in
 * SUPPORTED_TYPES_ARRAY has a pricing strategy and a decomposer
 * registered.
 *
 * This test will catch regressions when new types are added to
 * SUPPORTED_TYPES_ARRAY without corresponding pricing support.
 *
 * @see Story 40.5
 * @see A1 (2026-04-08) — EFS lifted the count from 25 to 26
 * @see EPIC-106-8 (2026-05-14) — parity guard: no known-priced metric renders "unavailable"
 */

import { describe, it, expect, vi } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { SUPPORTED_TYPES_ARRAY } from "../../config/resource-types.js";
import { defaultPricingRegistry, defaultDecomposerRegistry } from "../index.js";
import { queryLineItemPrices } from "../../graph/nodes/preflight-guard/pricing/breakdown.js";
import { ToolName } from "../../constants/tools.js";
import {
  McpMocks,
  createS3PricingDispatchTool,
} from "../../test-fixtures/mcp-mock-responses.js";
import { s3PricingDecomposer } from "./s3.js";
import { dynamodbPricingDecomposer } from "./dynamodb.js";

// Bypass the file-system price cache for parity-guard tests.
// The cache writes to ~/.assignee/cache/pricing/ and persists across test
// workers in CI — a stale entry written by another test in the same coverage
// run can be read back here, causing queryLineItemPrices to skip the mock
// tool and return "unavailable" for line items the mock would have resolved.
// Always-miss / no-op stubs are safe: the parity guard only cares about
// whether the mock tool returns the right price, not caching behaviour.
vi.mock("../../services/price-cache.js", () => ({
  getCachedPrice: vi.fn(() => null),
  setCachedPrice: vi.fn(),
  sweepExpiredPriceCache: vi.fn(),
  clearAllPriceCache: vi.fn(),
}));

// Note: The PricingStrategyRegistry does not expose a `has()` method —
// it only has `estimate(resourceType, desiredState)`.
// We call estimate() with undefined desiredState and check it returns a non-empty label.
// The PricingDecomposerRegistry has `has()`.

describe("pricing coverage — all supported resource types", () => {
  it("SUPPORTED_TYPES_ARRAY has exactly 38 types (37 + AWS::EC2::EIP via e98.W5.N5)", () => {
    expect(SUPPORTED_TYPES_ARRAY).toHaveLength(38);
  });

  describe("pricing strategy registered for every type", () => {
    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      it(`has pricing strategy for ${resourceType}`, () => {
        const estimate = defaultPricingRegistry.estimate(
          resourceType,
          undefined,
        );
        // Every registered strategy returns a meaningful label (e.g. "Free" or "Hourly + per-GB").
        // The fallback returns "Pricing unavailable", so we reject that.
        expect(estimate.label).toBeTruthy();
        expect(estimate.label).not.toBe("Pricing unavailable");
      });
    }
  });

  describe("pricing decomposer registered for every type", () => {
    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      it(`has pricing decomposer for ${resourceType}`, () => {
        expect(defaultDecomposerRegistry.has(resourceType)).toBe(true);
      });
    }
  });
});

// ── EPIC-106-8 parity guard ───────────────────────────────────────────────────
// Asserts that no known-priced S3 or DynamoDB metric renders "unavailable"
// when the pricing tool returns canonical us-east-1 fixtures.
// This guard would have caught the pre-fix "unavailable" on PUT/GET requests.

/** DynamoDB on-demand fixture — $1.25 per million read request units */
function buildDdbReadResponse(): unknown {
  return {
    type: "text",
    text: JSON.stringify({
      status: "success",
      service_name: "AmazonDynamoDB",
      data: [
        {
          product: {
            productFamily: "Amazon DynamoDB PayPerRequest Throughput",
            attributes: {
              regionCode: "us-east-1",
              group: "DDB-ReadUnits",
              servicecode: "AmazonDynamoDB",
            },
            sku: "DDBRDSKU0000001",
          },
          terms: {
            OnDemand: {
              "DDBRDSKU0000001.JRTCKXETXF": {
                priceDimensions: {
                  "DDBRDSKU0000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "ReadRequestUnits",
                    endRange: "Inf",
                    description: "$1.25 per million read request units",
                    appliesTo: [],
                    rateCode: "DDBRDSKU0000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: { USD: "0.0000012500" },
                  },
                },
                sku: "DDBRDSKU0000001",
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
      message: "Retrieved pricing for AmazonDynamoDB in us-east-1",
    }),
  };
}

/** DynamoDB on-demand fixture — $1.25 per million write request units */
function buildDdbWriteResponse(): unknown {
  return {
    type: "text",
    text: JSON.stringify({
      status: "success",
      service_name: "AmazonDynamoDB",
      data: [
        {
          product: {
            productFamily: "Amazon DynamoDB PayPerRequest Throughput",
            attributes: {
              regionCode: "us-east-1",
              group: "DDB-WriteUnits",
              servicecode: "AmazonDynamoDB",
            },
            sku: "DDBWRSKU0000001",
          },
          terms: {
            OnDemand: {
              "DDBWRSKU0000001.JRTCKXETXF": {
                priceDimensions: {
                  "DDBWRSKU0000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "WriteRequestUnits",
                    endRange: "Inf",
                    description: "$1.25 per million write request units",
                    appliesTo: [],
                    rateCode: "DDBWRSKU0000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: { USD: "0.0000012500" },
                  },
                },
                sku: "DDBWRSKU0000001",
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
      message: "Retrieved pricing for AmazonDynamoDB in us-east-1",
    }),
  };
}

/** DynamoDB storage fixture — $0.25 per GB-month */
function buildDdbStorageResponse(): unknown {
  return {
    type: "text",
    text: JSON.stringify({
      status: "success",
      service_name: "AmazonDynamoDB",
      data: [
        {
          product: {
            productFamily: "Database Storage",
            attributes: {
              regionCode: "us-east-1",
              usagetype: "TimedStorage-ByteHrs",
              servicecode: "AmazonDynamoDB",
            },
            sku: "DDBSTRSKU000001",
          },
          terms: {
            OnDemand: {
              "DDBSTRSKU000001.JRTCKXETXF": {
                priceDimensions: {
                  "DDBSTRSKU000001.JRTCKXETXF.6YS6EN2CT7": {
                    unit: "GB-Mo",
                    endRange: "Inf",
                    description: "$0.25 per GB-month",
                    appliesTo: [],
                    rateCode: "DDBSTRSKU000001.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: { USD: "0.2500000000" },
                  },
                },
                sku: "DDBSTRSKU000001",
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
      message: "Retrieved pricing for AmazonDynamoDB in us-east-1",
    }),
  };
}

function createDdbPricingDispatchTool(): StructuredTool {
  const ddbRead = buildDdbReadResponse();
  const ddbWrite = buildDdbWriteResponse();
  const ddbStorage = buildDdbStorageResponse();
  return {
    name: ToolName.GET_PRICING,
    description: "",
    invoke: vi.fn(
      async (args: {
        filters?: Array<{ Field: string; Value: string }>;
        service_code?: string;
      }) => {
        const filters = args.filters ?? [];
        if (
          filters.some(
            (f) => f.Field === "group" && f.Value === "DDB-ReadUnits",
          )
        )
          return ddbRead;
        if (
          filters.some(
            (f) => f.Field === "group" && f.Value === "DDB-WriteUnits",
          )
        )
          return ddbWrite;
        if (
          filters.some(
            (f) =>
              f.Field === "productFamily" && f.Value === "Database Storage",
          )
        )
          return ddbStorage;
        return McpMocks.pricing.emptyData.success;
      },
    ),
  } as unknown as StructuredTool;
}

describe("decomposer-parity guard — no known-priced metric renders unavailable (EPIC-106-8)", () => {
  it("S3 PUT/GET requests and storage all resolve to real prices (not unavailable)", async () => {
    const s3Items = s3PricingDecomposer.decompose({
      BucketName: "test-bucket",
    });
    const s3Tool = createS3PricingDispatchTool();
    const breakdown = await queryLineItemPrices(
      s3Items,
      [s3Tool],
      "parity-test",
    );

    const unavailable = breakdown.usageBasedItems.filter(
      (i) => i.displayPrice === "unavailable",
    );
    expect(unavailable).toHaveLength(0);

    // Explicitly verify PUT and GET are priced
    const putItem = breakdown.usageBasedItems.find(
      (i) => i.lineItem.label === "PUT requests",
    );
    const getItem = breakdown.usageBasedItems.find(
      (i) => i.lineItem.label === "GET requests",
    );
    expect(putItem?.unitPrice).not.toBeNull();
    expect(getItem?.unitPrice).not.toBeNull();
  });

  it("DynamoDB on-demand read/write capacity units resolve to real prices (not unavailable)", async () => {
    const ddbItems = dynamodbPricingDecomposer.decompose({
      BillingMode: "PAY_PER_REQUEST",
    });
    const ddbTool = createDdbPricingDispatchTool();
    const breakdown = await queryLineItemPrices(
      ddbItems,
      [ddbTool],
      "parity-test",
    );

    const unavailable = breakdown.usageBasedItems.filter(
      (i) => i.displayPrice === "unavailable",
    );
    expect(unavailable).toHaveLength(0);
  });
});
