import { describe, it, expect } from "vitest";
import { extractFirstTierPrice } from "./mcp-parser.js";
import type { AwsPricingResponse } from "./types.js";

describe("extractFirstTierPrice — contract tests for AwsPricingResponse shape", () => {
  it("extracts price from valid response with beginRange=0", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          terms: {
            OnDemand: {
              "term-1": {
                priceDimensions: {
                  "dim-1": {
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

    const result = extractFirstTierPrice(data, "/GB-month");
    expect(result).toBe("$0.0230/GB-month");
  });

  it("returns null for empty data array", () => {
    const data: AwsPricingResponse = { data: [] };
    expect(extractFirstTierPrice(data, "/hr")).toBeNull();
  });

  it("returns null for undefined data", () => {
    const data: AwsPricingResponse = {};
    expect(extractFirstTierPrice(data, "/hr")).toBeNull();
  });

  it("returns null for zero USD price", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          terms: {
            OnDemand: {
              "term-1": {
                priceDimensions: {
                  "dim-1": {
                    beginRange: "0",
                    pricePerUnit: { USD: "0.0000000000" },
                  },
                },
              },
            },
          },
        },
      ],
    };

    expect(extractFirstTierPrice(data, "/hr")).toBeNull();
  });

  it("skips non-zero beginRange tiers", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          terms: {
            OnDemand: {
              "term-1": {
                priceDimensions: {
                  "dim-1": {
                    beginRange: "51200",
                    pricePerUnit: { USD: "0.0125" },
                  },
                },
              },
            },
          },
        },
      ],
    };

    expect(extractFirstTierPrice(data, "/GB-month")).toBeNull();
  });

  it("applies scale factor", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          terms: {
            OnDemand: {
              "term-1": {
                priceDimensions: {
                  "dim-1": {
                    beginRange: "0",
                    pricePerUnit: { USD: "0.0000002" },
                  },
                },
              },
            },
          },
        },
      ],
    };

    const result = extractFirstTierPrice(data, "/million requests", 1_000_000);
    expect(result).toBe("$0.2000/million requests");
  });

  it("returns matching item when expectedFilters match product attributes", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          product: {
            productFamily: "Storage",
            attributes: { usagetype: "TimedStorage-ByteHrs" },
          },
          terms: {
            OnDemand: {
              "term-storage": {
                priceDimensions: {
                  "dim-1": {
                    beginRange: "0",
                    pricePerUnit: { USD: "0.0230" },
                  },
                },
              },
            },
          },
        },
        {
          product: {
            productFamily: "API Request",
            attributes: { usagetype: "Requests-Tier1" },
          },
          terms: {
            OnDemand: {
              "term-api": {
                priceDimensions: {
                  "dim-1": {
                    beginRange: "0",
                    pricePerUnit: { USD: "0.0000055" },
                  },
                },
              },
            },
          },
        },
      ],
    };

    const filters = [
      { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" as const },
      { Field: "usagetype", Value: "Requests-Tier1", Type: "TERM_MATCH" as const },
    ];

    const result = extractFirstTierPrice(data, "/1k requests", 1000, filters);
    expect(result).toBe("$0.0055/1k requests");
  });

  it("returns null (not wrong price) when expectedFilters match nothing", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          product: {
            productFamily: "Storage",
            attributes: { usagetype: "TimedStorage-ByteHrs" },
          },
          terms: {
            OnDemand: {
              "term-storage": {
                priceDimensions: {
                  "dim-1": {
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

    // Querying for PUT requests but only storage items exist
    const filters = [
      { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" as const },
      { Field: "usagetype", Value: "Requests-Tier1", Type: "TERM_MATCH" as const },
    ];

    const result = extractFirstTierPrice(data, "/1k requests", 1000, filters);
    // Must return null — NOT $0.0230 (the storage price)
    expect(result).toBeNull();
  });

  it("returns null when items lack product metadata and expectedFilters are provided", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          // No product field at all — itemMatchesFilters returns false
          terms: {
            OnDemand: {
              "term-1": {
                priceDimensions: {
                  "dim-1": {
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

    const filters = [
      { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" as const },
    ];

    const result = extractFirstTierPrice(data, "/1k requests", 1, filters);
    // No fallback to unfiltered items — return null
    expect(result).toBeNull();
  });

  it("returns price from unfiltered items when no expectedFilters provided", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          // No product metadata, but no filters requested either
          terms: {
            OnDemand: {
              "term-1": {
                priceDimensions: {
                  "dim-1": {
                    beginRange: "0",
                    pricePerUnit: { USD: "0.0500" },
                  },
                },
              },
            },
          },
        },
      ],
    };

    const result = extractFirstTierPrice(data, "/GB-month");
    expect(result).toBe("$0.0500/GB-month");
  });
});
