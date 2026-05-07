import { describe, it, expect } from "vitest";
import { extractFirstTierPrice, extractTieredPrice } from "./mcp-parser.js";
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
      {
        Field: "productFamily",
        Value: "API Request",
        Type: "TERM_MATCH" as const,
      },
      {
        Field: "usagetype",
        Value: "Requests-Tier1",
        Type: "TERM_MATCH" as const,
      },
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
      {
        Field: "productFamily",
        Value: "API Request",
        Type: "TERM_MATCH" as const,
      },
      {
        Field: "usagetype",
        Value: "Requests-Tier1",
        Type: "TERM_MATCH" as const,
      },
    ];

    const result = extractFirstTierPrice(data, "/1k requests", 1000, filters);
    // Must return null — NOT $0.0230 (the storage price)
    expect(result).toBeNull();
  });

  it("trusts single item with no product metadata when filters are provided (MCP filtered server-side)", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          // No product field — single-item fallback trusts MCP server-side filtering
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
      {
        Field: "productFamily",
        Value: "API Request",
        Type: "TERM_MATCH" as const,
      },
    ];

    const result = extractFirstTierPrice(data, "/1k requests", 1, filters);
    // Single item, no metadata: trust MCP server-side filtering
    expect(result).toBe("$0.0230/1k requests");
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

// ─── extractTieredPrice ───────────────────────────────────────────────────────

describe("extractTieredPrice — tiered AWS Pricing response detection", () => {
  it("returns a TierLadderRender for a response with multiple priceDimensions", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          terms: {
            OnDemand: {
              "term-1": {
                priceDimensions: {
                  "dim-1": {
                    beginRange: "0",
                    endRange: "100",
                    pricePerUnit: { USD: "0.0000000000" },
                    unit: "GB",
                  },
                  "dim-2": {
                    beginRange: "100",
                    endRange: "10240",
                    pricePerUnit: { USD: "0.0900000000" },
                    unit: "GB",
                  },
                },
              },
            },
          },
        },
      ],
    };

    const result = extractTieredPrice(data);
    expect(result).toBeDefined();
    expect(result!.tiers).toHaveLength(2);
    expect(result!.text).toContain("free up to 100 GB");
  });

  it("returns undefined for a flat-rate response (single priceDimension)", () => {
    const data: AwsPricingResponse = {
      data: [
        {
          terms: {
            OnDemand: {
              "term-1": {
                priceDimensions: {
                  "dim-1": {
                    beginRange: "0",
                    endRange: "Inf",
                    pricePerUnit: { USD: "0.0230" },
                  },
                },
              },
            },
          },
        },
      ],
    };

    // Single dimension — isTieredResponse returns false, so extractTieredPrice returns undefined
    const result = extractTieredPrice(data);
    expect(result).toBeUndefined();
  });

  it("respects expectedFilters: only matches the filtered item's tiered dims", () => {
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
                    endRange: "Inf",
                    pricePerUnit: { USD: "0.0230" },
                  },
                },
              },
            },
          },
        },
        {
          product: {
            productFamily: "Data Transfer",
          },
          terms: {
            OnDemand: {
              "term-transfer": {
                priceDimensions: {
                  "dim-a": {
                    beginRange: "0",
                    endRange: "100",
                    pricePerUnit: { USD: "0.0000000000" },
                    unit: "GB",
                  },
                  "dim-b": {
                    beginRange: "100",
                    endRange: "Inf",
                    pricePerUnit: { USD: "0.0900000000" },
                    unit: "GB",
                  },
                },
              },
            },
          },
        },
      ],
    };

    // Filter for Data Transfer only — should see the tiered dimensions
    const filters = [
      {
        Field: "productFamily",
        Value: "Data Transfer",
        Type: "TERM_MATCH" as const,
      },
    ];
    const result = extractTieredPrice(data, filters);
    expect(result).toBeDefined();
    expect(result!.tiers).toHaveLength(2);
  });
});
