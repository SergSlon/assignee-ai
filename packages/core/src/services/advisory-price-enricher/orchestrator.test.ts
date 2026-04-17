/**
 * Tests for the advisory price enricher service (Story 46.3).
 *
 * Drives every entry in the enrichable price registry through:
 *   1. Live MCP success path → source: "mcp", value extracted from response
 *   2. MCP failure path → source: "fallback", value = hand-coded constant
 *   3. Mixed: one query timeouts, others succeed → per-query isolation
 *   4. Missing tool entirely → all-fallback (no MCP traffic at all)
 *
 * Mock responses use the actual `{type:"text", text: JSON}` shape that
 * the Pricing MCP server emits, parsed by `extractFirstTierPrice`.
 *
 * Lifted from apps/cli/src/services/__tests__/advisory-price-enricher.test.ts
 * in Story 50-4 Wave 5 Pass G — assertions byte-identical to CLI version.
 */

import { describe, it, expect, vi } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../../constants/tools.js";
import { AdvisoryPriceId } from "../../pricing/advisory-prices.js";
import { enrichAdvisoryPrices } from "./orchestrator.js";
import { ENRICHABLE_PRICE_IDS } from "./types.js";

/**
 * Build a captured-shape Pricing MCP response. The structure here mirrors
 * the real `{status, data: [{ product, terms: { OnDemand: {...} } }]}`
 * payload that `extractFirstTierPrice` parses.
 */
function buildPricingResponse(opts: {
  productFamily: string;
  attributes: Record<string, string>;
  priceUsd: string;
  unit: string;
}): { type: "text"; text: string } {
  return {
    type: "text",
    text: JSON.stringify({
      status: "success",
      data: [
        {
          product: {
            productFamily: opts.productFamily,
            attributes: { regionCode: "us-east-1", ...opts.attributes },
            sku: "TEST-SKU-1",
          },
          terms: {
            OnDemand: {
              "TEST-SKU-1.JRTCKXETXF": {
                priceDimensions: {
                  "TEST-SKU-1.JRTCKXETXF.6YS6EN2CT7": {
                    unit: opts.unit,
                    endRange: "Inf",
                    description: `Test ${opts.productFamily}`,
                    rateCode: "TEST-SKU-1.JRTCKXETXF.6YS6EN2CT7",
                    beginRange: "0",
                    pricePerUnit: { USD: opts.priceUsd },
                  },
                },
                sku: "TEST-SKU-1",
                effectiveDate: "2026-04-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260411000000",
          publicationDate: "2026-04-11T00:00:00Z",
        },
      ],
      message: "Retrieved pricing from AWS Pricing API",
    }),
  };
}

/**
 * Build a tool that dispatches per-query: every Pricing MCP call gets a
 * captured-shape response keyed off the productFamily filter. Different
 * filters → different prices, so per-row provenance is verifiable.
 */
function makeFilterDispatchedPricingTool(
  responses: Record<string, { type: "text"; text: string }>,
): StructuredTool {
  return {
    name: ToolName.GET_PRICING,
    description: "",
    invoke: vi
      .fn()
      .mockImplementation(
        async (args: { filters: Array<{ Field: string; Value: string }> }) => {
          const productFamilyFilter = args.filters.find(
            (f) => f.Field === "productFamily",
          );
          const key = productFamilyFilter?.Value ?? "DEFAULT";
          return responses[key] ?? null;
        },
      ),
  } as unknown as StructuredTool;
}

// Hourly $0.045 → monthly via convert callback (* 730)
const natGatewayResponse = buildPricingResponse({
  productFamily: "NAT Gateway",
  attributes: { usagetype: "NatGateway-Hours" },
  priceUsd: "0.0450000000",
  unit: "Hrs",
});

const albResponse = buildPricingResponse({
  productFamily: "Load Balancer",
  attributes: { usagetype: "LoadBalancerUsage" },
  priceUsd: "0.0225000000",
  unit: "Hrs",
});

const cwAlarmResponse = buildPricingResponse({
  productFamily: "Alarm",
  attributes: {},
  priceUsd: "0.1000000000",
  unit: "Alarm-Mo",
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("enrichAdvisoryPrices — coverage invariants", () => {
  it("registry exposes the 3 verified enrichable advisory price IDs", () => {
    // Wave-2 review: only verified queries ship live. The other 4
    // AdvisoryPriceId enum members (EFS, CW Logs, CF invalidation,
    // EventBridge) intentionally have no query — cost-advisor still
    // references them via `enrichedLabel` which falls back to the
    // formatted constant tagged "(estimated)".
    expect(ENRICHABLE_PRICE_IDS.length).toBe(3);
    expect(ENRICHABLE_PRICE_IDS).toContain(AdvisoryPriceId.NAT_GATEWAY_MONTHLY);
    expect(ENRICHABLE_PRICE_IDS).toContain(AdvisoryPriceId.ALB_MONTHLY);
    expect(ENRICHABLE_PRICE_IDS).toContain(AdvisoryPriceId.CW_ALARM_PER_MONTH);
    // The 4 unverified IDs are NOT in the registry yet.
    expect(ENRICHABLE_PRICE_IDS).not.toContain(
      AdvisoryPriceId.CW_LOGS_INGESTION_PER_GB,
    );
    expect(ENRICHABLE_PRICE_IDS).not.toContain(
      AdvisoryPriceId.CF_INVALIDATION_EACH,
    );
    expect(ENRICHABLE_PRICE_IDS).not.toContain(
      AdvisoryPriceId.EVENTBRIDGE_CUSTOM_PER_MILLION,
    );
    expect(ENRICHABLE_PRICE_IDS).not.toContain(
      AdvisoryPriceId.EFS_PROVISIONED_PER_MIBS_MONTH,
    );
  });
});

describe("enrichAdvisoryPrices — missing tool", () => {
  it("returns an all-fallback map when tools is undefined", async () => {
    const map = await enrichAdvisoryPrices(undefined);
    expect(map.size).toBe(ENRICHABLE_PRICE_IDS.length);
    for (const id of ENRICHABLE_PRICE_IDS) {
      const entry = map.get(id);
      expect(entry).toBeDefined();
      expect(entry?.source).toBe("fallback");
      expect(entry?.label).toContain("(estimated)");
    }
  });

  it("returns an all-fallback map when tools is an empty array", async () => {
    const map = await enrichAdvisoryPrices([]);
    expect(map.size).toBe(ENRICHABLE_PRICE_IDS.length);
    expect(
      [...map.values()].every((entry) => entry.source === "fallback"),
    ).toBe(true);
  });

  it("returns an all-fallback map when no Pricing tool is in the array", async () => {
    const otherTool = {
      name: "some-other-tool",
      description: "",
      invoke: vi.fn(),
    } as unknown as StructuredTool;
    const map = await enrichAdvisoryPrices([otherTool]);
    expect(map.size).toBe(ENRICHABLE_PRICE_IDS.length);
    expect(
      [...map.values()].every((entry) => entry.source === "fallback"),
    ).toBe(true);
    // The non-pricing tool's invoke must NOT have been called.
    expect(otherTool.invoke).not.toHaveBeenCalled();
  });
});

describe("enrichAdvisoryPrices — live MCP path", () => {
  it("tags NAT Gateway, ALB, and CW Alarm as 'mcp' AND issues correct service_code/filter calls", async () => {
    const tool = makeFilterDispatchedPricingTool({
      "NAT Gateway": natGatewayResponse,
      "Load Balancer": albResponse,
      Alarm: cwAlarmResponse,
    });
    const map = await enrichAdvisoryPrices([tool]);

    const nat = map.get(AdvisoryPriceId.NAT_GATEWAY_MONTHLY);
    expect(nat?.source).toBe("mcp");
    expect(nat?.label).toContain("(live)");
    // 0.045 * 730 = 32.85 — rounded by toFixed(2)
    expect(nat?.label).toContain("~$32.85/mo");

    const alb = map.get(AdvisoryPriceId.ALB_MONTHLY);
    expect(alb?.source).toBe("mcp");
    expect(alb?.label).toContain("(live)");
    // 0.0225 * 730 = 16.425 → toFixed(2) = 16.43 (IEEE 754 round-to-even)
    expect(alb?.label).toContain("~$16.43/mo");

    const alarm = map.get(AdvisoryPriceId.CW_ALARM_PER_MONTH);
    expect(alarm?.source).toBe("mcp");
    expect(alarm?.label).toContain("(live)");
    expect(alarm?.label).toContain("$0.10/alarm/month");

    // Wave-2 Blind Hunter H1: assert the actual MCP call shape — a
    // regression that swaps service_code or drops a filter would
    // otherwise still pass because the dispatch mock only inspects
    // productFamily.
    const invokeCalls = (
      tool.invoke as unknown as {
        mock: { calls: Array<[Record<string, unknown>]> };
      }
    ).mock.calls;

    const natCall = invokeCalls.find((c) => {
      const filters = (c[0]?.["filters"] as Array<{ Value: string }>) ?? [];
      return filters.some((f) => f.Value === "NAT Gateway");
    });
    expect(natCall).toBeDefined();
    expect(natCall?.[0]["service_code"]).toBe("AmazonEC2");
    expect(natCall?.[0]["region"]).toBeDefined();
    const natFilters = natCall?.[0]["filters"] as Array<{
      Field: string;
      Value: string;
    }>;
    // NAT must include BOTH the productFamily AND the usagetype filter,
    // otherwise the Pricing API would return data-processing rates.
    expect(
      natFilters.some(
        (f) => f.Field === "productFamily" && f.Value === "NAT Gateway",
      ),
    ).toBe(true);
    expect(
      natFilters.some(
        (f) => f.Field === "usagetype" && f.Value === "NatGateway-Hours",
      ),
    ).toBe(true);

    const albCall = invokeCalls.find((c) => {
      const filters = (c[0]?.["filters"] as Array<{ Value: string }>) ?? [];
      return filters.some((f) => f.Value === "Load Balancer");
    });
    expect(albCall?.[0]["service_code"]).toBe("ElasticLoadBalancing");

    const alarmCall = invokeCalls.find((c) => {
      const filters = (c[0]?.["filters"] as Array<{ Value: string }>) ?? [];
      return filters.some((f) => f.Value === "Alarm");
    });
    expect(alarmCall?.[0]["service_code"]).toBe("AmazonCloudWatch");
  });

  it("falls back to constants for enrichable IDs the tool returns no response for", async () => {
    // Only NAT Gateway has a captured response — the other 2
    // enrichable IDs (ALB, CW Alarm) fall back. The 4 unenriched IDs
    // (CW Logs, CF, EventBridge, EFS) are absent from the map entirely.
    const tool = makeFilterDispatchedPricingTool({
      "NAT Gateway": natGatewayResponse,
    });
    const map = await enrichAdvisoryPrices([tool]);

    expect(map.get(AdvisoryPriceId.NAT_GATEWAY_MONTHLY)?.source).toBe("mcp");
    expect(map.get(AdvisoryPriceId.ALB_MONTHLY)?.source).toBe("fallback");
    expect(map.get(AdvisoryPriceId.CW_ALARM_PER_MONTH)?.source).toBe(
      "fallback",
    );
    // Unenriched IDs: not in the map at all.
    expect(map.has(AdvisoryPriceId.CW_LOGS_INGESTION_PER_GB)).toBe(false);
    expect(map.has(AdvisoryPriceId.CF_INVALIDATION_EACH)).toBe(false);
    expect(map.has(AdvisoryPriceId.EVENTBRIDGE_CUSTOM_PER_MILLION)).toBe(false);
    expect(map.has(AdvisoryPriceId.EFS_PROVISIONED_PER_MIBS_MONTH)).toBe(false);
  });
});

describe("enrichAdvisoryPrices — failure isolation", () => {
  it("isolates per-query rejections — only the throwing ID falls back, others succeed", async () => {
    // Wave-2 Blind Hunter M1: pin down which ID failed. Use a
    // dispatch tool that ONLY rejects when the NAT Gateway filter is
    // present, so we can assert exactly NAT Gateway → fallback while
    // ALB and CW Alarm still resolve to "mcp".
    const tool = {
      name: ToolName.GET_PRICING,
      description: "",
      invoke: vi
        .fn()
        .mockImplementation(
          async (args: { filters: Array<{ Value: string }> }) => {
            if (args.filters.some((f) => f.Value === "NAT Gateway")) {
              throw new Error("network down");
            }
            if (args.filters.some((f) => f.Value === "Load Balancer")) {
              return albResponse;
            }
            if (args.filters.some((f) => f.Value === "Alarm")) {
              return cwAlarmResponse;
            }
            return null;
          },
        ),
    } as unknown as StructuredTool;

    const map = await enrichAdvisoryPrices([tool]);
    expect(map.size).toBe(ENRICHABLE_PRICE_IDS.length);
    // The throwing ID is fallback; the other 2 are mcp. Exactly.
    expect(map.get(AdvisoryPriceId.NAT_GATEWAY_MONTHLY)?.source).toBe(
      "fallback",
    );
    expect(map.get(AdvisoryPriceId.ALB_MONTHLY)?.source).toBe("mcp");
    expect(map.get(AdvisoryPriceId.CW_ALARM_PER_MONTH)?.source).toBe("mcp");
  });

  it("returns all-fallback when every fetch rejects", async () => {
    const tool = {
      name: ToolName.GET_PRICING,
      description: "",
      invoke: vi.fn().mockRejectedValue(new Error("DNS resolution failed")),
    } as unknown as StructuredTool;

    const map = await enrichAdvisoryPrices([tool]);
    expect(map.size).toBe(ENRICHABLE_PRICE_IDS.length);
    expect(
      [...map.values()].every((entry) => entry.source === "fallback"),
    ).toBe(true);
    // All-fallback labels carry the (estimated) suffix.
    for (const entry of map.values()) {
      expect(entry.label).toContain("(estimated)");
    }
  });

  it("never throws — even when the Pricing tool throws synchronously", async () => {
    const tool = {
      name: ToolName.GET_PRICING,
      description: "",
      invoke: vi.fn(() => {
        throw new Error("synchronous explosion");
      }),
    } as unknown as StructuredTool;

    // Must not throw — the enricher's catch block converts the error
    // into a fallback row.
    await expect(enrichAdvisoryPrices([tool])).resolves.toBeDefined();
    const map = await enrichAdvisoryPrices([tool]);
    expect(map.size).toBe(ENRICHABLE_PRICE_IDS.length);
  });
});

describe("enrichAdvisoryPrices — timeout path", () => {
  it("falls back to constants when the per-query timeout fires (Blind Hunter H3)", async () => {
    // The previous tests only exercised synchronous errors and
    // null-returning fetches. This one drives the actual setTimeout →
    // withTimeout(...) → null code path that fires when a Pricing MCP
    // call hangs longer than ENRICHMENT_TIMEOUT_MS (3000ms). Removing
    // the timeout wrapper or breaking the null-return contract would
    // make this test hang or assert wrong source values.
    vi.useFakeTimers();
    try {
      const tool = {
        name: ToolName.GET_PRICING,
        description: "",
        // Never resolves on its own — the only way this returns is via
        // the withTimeout wrapper firing.
        invoke: vi.fn().mockImplementation(() => new Promise(() => {})),
      } as unknown as StructuredTool;

      const promise = enrichAdvisoryPrices([tool]);
      // Advance fake time past the per-query budget for all 3 parallel
      // queries to time out.
      await vi.advanceTimersByTimeAsync(3001);

      const map = await promise;
      expect(map.size).toBe(ENRICHABLE_PRICE_IDS.length);
      // Every entry must be fallback because the live path never
      // produced a usable value.
      for (const id of ENRICHABLE_PRICE_IDS) {
        expect(map.get(id)?.source).toBe("fallback");
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("enrichAdvisoryPrices — fallback formatting", () => {
  it("fallback labels carry the formatted value AND the (estimated) suffix", async () => {
    // Wave-2 Blind Hunter M2: assert the formatter actually ran, not
    // just that "(estimated)" is somewhere in the string. Catches a
    // regression where the formatter is dropped or mis-imported.
    const map = await enrichAdvisoryPrices(undefined);
    const nat = map.get(AdvisoryPriceId.NAT_GATEWAY_MONTHLY);
    expect(nat?.label).toMatch(/^~\$\d+\.\d{2}\/mo \(estimated\)$/);
    const alb = map.get(AdvisoryPriceId.ALB_MONTHLY);
    expect(alb?.label).toMatch(/^~\$\d+\.\d{2}\/mo \(estimated\)$/);
    const alarm = map.get(AdvisoryPriceId.CW_ALARM_PER_MONTH);
    expect(alarm?.label).toMatch(/^\$\d+\.\d{2}\/alarm\/month \(estimated\)$/);
  });
});

describe("enrichAdvisoryPrices — extracted value handling", () => {
  it("treats malformed price string as fallback (defensive against future Pricing API changes)", async () => {
    // A response shaped like the real one but with a non-parseable USD
    // value — `extractFirstTierPrice` returns null, which our code
    // converts to a fallback row.
    const malformed = {
      type: "text" as const,
      text: JSON.stringify({
        status: "success",
        data: [
          {
            product: {
              productFamily: "NAT Gateway",
              attributes: { usagetype: "NatGateway-Hours" },
              sku: "BAD-1",
            },
            terms: {
              OnDemand: {
                "BAD-1.JRTCKXETXF": {
                  priceDimensions: {
                    "BAD-1.JRTCKXETXF.6YS6EN2CT7": {
                      unit: "Hrs",
                      endRange: "Inf",
                      beginRange: "0",
                      // pricePerUnit absent
                      pricePerUnit: {},
                    },
                  },
                },
              },
            },
          },
        ],
      }),
    };

    const tool = makeFilterDispatchedPricingTool({
      "NAT Gateway": malformed,
    });
    const map = await enrichAdvisoryPrices([tool]);
    expect(map.get(AdvisoryPriceId.NAT_GATEWAY_MONTHLY)?.source).toBe(
      "fallback",
    );
  });
});
