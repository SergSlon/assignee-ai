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
});
