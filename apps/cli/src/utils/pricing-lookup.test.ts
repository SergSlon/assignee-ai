import { vi, describe, it, expect, beforeEach } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";

// Mock price cache so tests don't hit filesystem
vi.mock("../services/price-cache.js", () => ({
  getCachedPrice: vi.fn(() => null),
  setCachedPrice: vi.fn(),
}));

import {
  fetchEc2InstancePrices,
  fetchRdsInstancePrices,
} from "./pricing-lookup.js";
import { ToolName } from "../constants/tools.js";

/** Build a minimal AWS Pricing API response with a single on-demand price. */
function makePricingResponse(priceUsd: number): string {
  return JSON.stringify({
    data: [
      {
        terms: {
          OnDemand: {
            "TERM-1": {
              priceDimensions: {
                "DIM-1": {
                  beginRange: "0",
                  pricePerUnit: { USD: String(priceUsd) },
                },
              },
            },
          },
        },
      },
    ],
  });
}

describe("fetchEc2InstancePrices", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty map when no pricing tool in tools array", async () => {
    const result = await fetchEc2InstancePrices([], ["t3.micro"]);
    expect(result).toEqual({});
  });

  it("returns empty map when tool returns null", async () => {
    const tool: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockResolvedValue(null),
    } as unknown as StructuredTool;
    const result = await fetchEc2InstancePrices([tool], ["t3.micro"]);
    expect(result).toEqual({});
  });

  it("returns empty map when tool throws", async () => {
    const tool: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockRejectedValue(new Error("network error")),
    } as unknown as StructuredTool;
    const result = await fetchEc2InstancePrices([tool], ["t3.micro"]);
    expect(result).toEqual({});
  });

  it("parses price and returns correct format for a single instance type", async () => {
    const tool: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockResolvedValue({ text: makePricingResponse(0.0104) }),
    } as unknown as StructuredTool;

    const result = await fetchEc2InstancePrices([tool], ["t3.micro"]);
    expect(result["t3.micro"]).toBeDefined();
    expect(result["t3.micro"]).toMatch(/^\$[\d.]+\/hr$/);
  });

  it("handles multiple instance types in parallel", async () => {
    const tool: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockResolvedValue({ text: makePricingResponse(0.0208) }),
    } as unknown as StructuredTool;

    const result = await fetchEc2InstancePrices(
      [tool],
      ["t3.micro", "t3.small"],
    );
    expect(Object.keys(result)).toHaveLength(2);
  });

  it("uses only the first matching GET_PRICING tool", async () => {
    const tool1: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockResolvedValue({ text: makePricingResponse(0.0104) }),
    } as unknown as StructuredTool;
    const tool2: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn(),
    } as unknown as StructuredTool;

    await fetchEc2InstancePrices([tool1, tool2], ["t3.micro"]);
    expect(tool1.invoke).toHaveBeenCalled();
    expect(tool2.invoke).not.toHaveBeenCalled();
  });

  it("silently excludes instance types with zero-price responses", async () => {
    const tool: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockResolvedValue({ text: makePricingResponse(0) }),
    } as unknown as StructuredTool;

    const result = await fetchEc2InstancePrices([tool], ["t3.micro"]);
    expect(result).toEqual({});
  });
});

describe("fetchRdsInstancePrices", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty map when no pricing tool found", async () => {
    const result = await fetchRdsInstancePrices(
      [],
      ["db.t3.micro"],
      "postgres",
    );
    expect(result).toEqual({});
  });

  it("returns empty map when tool returns null", async () => {
    const tool: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockResolvedValue(null),
    } as unknown as StructuredTool;
    const result = await fetchRdsInstancePrices(
      [tool],
      ["db.t3.micro"],
      "postgres",
    );
    expect(result).toEqual({});
  });

  it("parses price correctly for postgres engine", async () => {
    const tool: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockResolvedValue({ text: makePricingResponse(0.017) }),
    } as unknown as StructuredTool;

    const result = await fetchRdsInstancePrices(
      [tool],
      ["db.t3.micro"],
      "postgres",
    );
    expect(result["db.t3.micro"]).toBeDefined();
    expect(result["db.t3.micro"]).toMatch(/^\$[\d.]+\/hr$/);
  });

  it("does not add deploymentOption filter for Aurora engines", async () => {
    const tool: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockResolvedValue({ text: makePricingResponse(0.02) }),
    } as unknown as StructuredTool;

    await fetchRdsInstancePrices([tool], ["db.t3.micro"], "aurora-postgresql");

    const mockFn = tool.invoke as ReturnType<typeof vi.fn>;
    const callArgs = mockFn.mock.calls[0]?.[0] as {
      filters: Array<{ Field: string }>;
    };
    expect(callArgs).toBeDefined();
    const hasDeployment = callArgs.filters.some(
      (f) => f.Field === "deploymentOption",
    );
    expect(hasDeployment).toBe(false);
  });

  it("adds deploymentOption filter for non-Aurora engines", async () => {
    const tool: StructuredTool = {
      name: ToolName.GET_PRICING,
      invoke: vi.fn().mockResolvedValue({ text: makePricingResponse(0.017) }),
    } as unknown as StructuredTool;

    await fetchRdsInstancePrices([tool], ["db.t3.micro"], "postgres");

    const mockFn = tool.invoke as ReturnType<typeof vi.fn>;
    const callArgs = mockFn.mock.calls[0]?.[0] as {
      filters: Array<{ Field: string }>;
    };
    expect(callArgs).toBeDefined();
    const hasDeployment = callArgs.filters.some(
      (f) => f.Field === "deploymentOption",
    );
    expect(hasDeployment).toBe(true);
  });
});
