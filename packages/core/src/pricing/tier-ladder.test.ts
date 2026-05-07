/**
 * Tests for tier-ladder.ts — tiered AWS Pricing API rendering helper.
 *
 * @see Story: feature-pricing-tiered-rate-display
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { isTieredResponse, renderTierLadder } from "./tier-ladder.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── isTieredResponse ─────────────────────────────────────────────────────────

describe("isTieredResponse", () => {
  it("returns false for a single dimension (flat rate)", () => {
    expect(
      isTieredResponse({
        "dim-1": {
          beginRange: "0",
          endRange: "Inf",
          pricePerUnit: { USD: "0.0230" },
        },
      }),
    ).toBe(false);
  });

  it("returns false for empty dimensions object", () => {
    expect(isTieredResponse({})).toBe(false);
  });

  it("returns true for two dimensions", () => {
    expect(
      isTieredResponse({
        "dim-1": {
          beginRange: "0",
          endRange: "100",
          pricePerUnit: { USD: "0.0000000000" },
        },
        "dim-2": {
          beginRange: "100",
          endRange: "Inf",
          pricePerUnit: { USD: "0.0900000000" },
        },
      }),
    ).toBe(true);
  });

  it("returns true for four or more dimensions", () => {
    expect(
      isTieredResponse({
        "dim-1": {
          beginRange: "0",
          endRange: "100",
          pricePerUnit: { USD: "0.0000000000" },
        },
        "dim-2": {
          beginRange: "100",
          endRange: "10240",
          pricePerUnit: { USD: "0.0900000000" },
        },
        "dim-3": {
          beginRange: "10240",
          endRange: "51200",
          pricePerUnit: { USD: "0.0850000000" },
        },
        "dim-4": {
          beginRange: "51200",
          endRange: "Inf",
          pricePerUnit: { USD: "0.0700000000" },
        },
      }),
    ).toBe(true);
  });
});

// ─── renderTierLadder ────────────────────────────────────────────────────────

describe("renderTierLadder", () => {
  it("returns text 'free up to 100 GB, $0.090/GB next 10 TB' for standard S3 data-transfer 2-tier", () => {
    const result = renderTierLadder({
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
    });

    expect(result).toBeDefined();
    expect(result!.text).toBe("free up to 100 GB, $0.090/GB next 10 TB");
    expect(result!.tiers).toHaveLength(2);
    expect(result!.tiers[0]).toMatchObject({
      beginRange: 0,
      endRange: 100,
      rate: "0.0000000000",
      currency: "USD",
      unit: "GB",
    });
    expect(result!.tiers[1]).toMatchObject({
      beginRange: 100,
      endRange: 10240,
      rate: "0.0900000000",
      currency: "USD",
      unit: "GB",
    });
  });

  it("renders 3-tier all-paid ladder correctly", () => {
    // e.g. RDS backup or some hypothetical flat-from-start service
    const result = renderTierLadder({
      "dim-1": {
        beginRange: "0",
        endRange: "100",
        pricePerUnit: { USD: "0.1200000000" },
        unit: "GB",
      },
      "dim-2": {
        beginRange: "100",
        endRange: "10240",
        pricePerUnit: { USD: "0.0900000000" },
        unit: "GB",
      },
      "dim-3": {
        beginRange: "10240",
        endRange: "Inf",
        pricePerUnit: { USD: "0.0700000000" },
        unit: "GB",
      },
    });

    expect(result).toBeDefined();
    expect(result!.text).toBe(
      "$0.120/GB up to 100 GB, $0.090/GB next 10 TB, $0.070/GB above 10 TB",
    );
    expect(result!.tiers).toHaveLength(3);
    // Top tier has no endRange (Inf)
    expect(result!.tiers[2]!.endRange).toBeUndefined();
  });

  it("renders 4+ tiers with ellipsis in text but full tiers array", () => {
    const result = renderTierLadder({
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
      "dim-3": {
        beginRange: "10240",
        endRange: "51200",
        pricePerUnit: { USD: "0.0850000000" },
        unit: "GB",
      },
      "dim-4": {
        beginRange: "51200",
        endRange: "Inf",
        pricePerUnit: { USD: "0.0700000000" },
        unit: "GB",
      },
    });

    expect(result).toBeDefined();
    expect(result!.text).toMatch(/,\s*…$/);
    expect(result!.text).toBe(
      "free up to 100 GB, $0.090/GB next 10 TB, $0.085/GB next 40 TB, …",
    );
    // All 4 tiers in the structured array
    expect(result!.tiers).toHaveLength(4);
  });

  it("returns undefined and logs warning for non-monotonic ranges", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = renderTierLadder({
      "dim-1": {
        beginRange: "0",
        endRange: "10",
        pricePerUnit: { USD: "0.0900000000" },
        unit: "GB",
      },
      "dim-2": {
        beginRange: "5", // overlaps with previous endRange=10
        endRange: "20",
        pricePerUnit: { USD: "0.0800000000" },
        unit: "GB",
      },
    });

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Non-monotonic price dimensions"),
    );
  });

  it("renders non-USD currency with correct prefix", () => {
    const result = renderTierLadder({
      "dim-1": {
        beginRange: "0",
        endRange: "100",
        pricePerUnit: { CNY: "0.0000000000" },
        unit: "GB",
      },
      "dim-2": {
        beginRange: "100",
        endRange: "Inf",
        pricePerUnit: { CNY: "0.6200000000" },
        unit: "GB",
      },
    });

    expect(result).toBeDefined();
    expect(result!.text).toContain("¥");
    expect(result!.tiers[0]!.currency).toBe("CNY");
  });

  it("returns 'free across all tiers' when all rates are zero", () => {
    const result = renderTierLadder({
      "dim-1": {
        beginRange: "0",
        endRange: "1000",
        pricePerUnit: { USD: "0.0000000000" },
        unit: "GB",
      },
      "dim-2": {
        beginRange: "1000",
        endRange: "Inf",
        pricePerUnit: { USD: "0.0000000000" },
        unit: "GB",
      },
    });

    expect(result).toBeDefined();
    expect(result!.text).toBe("free across all tiers");
    expect(result!.tiers).toHaveLength(2);
  });

  it("handles top tier with no endRange (open-ended)", () => {
    const result = renderTierLadder({
      "dim-1": {
        beginRange: "0",
        endRange: "100",
        pricePerUnit: { USD: "0.0000000000" },
        unit: "GB",
      },
      "dim-2": {
        beginRange: "100",
        // No endRange at all — top tier
        pricePerUnit: { USD: "0.0900000000" },
        unit: "GB",
      },
    });

    expect(result).toBeDefined();
    expect(result!.text).toContain("free up to 100 GB");
    expect(result!.tiers[1]!.endRange).toBeUndefined();
  });

  it("top tier has no endRange for Inf string", () => {
    const result = renderTierLadder({
      "dim-1": {
        beginRange: "0",
        endRange: "100",
        pricePerUnit: { USD: "0.0000000000" },
        unit: "GB",
      },
      "dim-2": {
        beginRange: "100",
        endRange: "Inf",
        pricePerUnit: { USD: "0.0900000000" },
        unit: "GB",
      },
    });

    expect(result).toBeDefined();
    // Inf endRange should become undefined in the tiers array
    expect(result!.tiers[1]!.endRange).toBeUndefined();
  });

  it("handles a single dimension (flat rate) — returns text for it since isTieredResponse=false guards separately", () => {
    // renderTierLadder with a single dim still works — just one tier
    // The isTieredResponse guard is in the caller (mcp-parser), not here.
    // But callers shouldn't call this with 1 dim; if they do, it's still valid.
    const result = renderTierLadder({
      "dim-1": {
        beginRange: "0",
        endRange: "Inf",
        pricePerUnit: { USD: "0.0230000000" },
        unit: "GB",
      },
    });
    // Single tier — not "tiered" per isTieredResponse, but renderTierLadder
    // still processes it: the sorted list has 1 entry, which is not all-zero.
    // It renders as "$0.023/GB up to Inf GB" — but this path is NOT normally
    // reached (isTieredResponse returns false for single dim).
    // We just verify it doesn't crash.
    expect(result).toBeDefined();
  });

  it("formats TB ranges for large endRange values", () => {
    const result = renderTierLadder({
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
    });

    // 10240 GB = 10 TB
    expect(result!.text).toContain("10 TB");
  });
});
