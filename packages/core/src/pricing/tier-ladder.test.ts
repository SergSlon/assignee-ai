/**
 * Tests for tier-ladder.ts — tiered AWS Pricing API rendering helper.
 *
 * @see Story: feature-pricing-tiered-rate-display
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isTieredResponse,
  renderTierLadder,
  formatRange,
} from "./tier-ladder.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// PD-1 probe suite — formatRange unit-family switch
// Closes PH1-A-1 (DDB Storage GB suffix), PH1-C-3 (SNS publishes TB drift),
// PH1-D-3 (Lambda GB-Seconds TB drift). Single-root-cause fix.
// ─────────────────────────────────────────────────────────────────────────────

describe("formatRange — unit-family switch (PD-1)", () => {
  // ── Variation A — bytes (GB→TB) preserved ─────────────────────────────────
  it("Variation A — large byte unit renders as TB (≥512 GB threshold)", () => {
    expect(formatRange(40960, "GB-Mo")).toBe("40 TB");
    expect(formatRange(10240, "GB-Mo")).toBe("10 TB");
    expect(formatRange(1024, "GB-Mo")).toBe("1 TB");
    expect(formatRange(512, "GB-Mo")).toBe("1 TB"); // boundary — rounds to 1 TB
  });

  // ── Variation B — bytes small (< 512 GB) ──────────────────────────────────
  it("Variation B — small byte unit renders as GB (< 512 GB)", () => {
    expect(formatRange(100, "GB-Mo")).toBe("100 GB");
    expect(formatRange(25, "GB-Mo")).toBe("25 GB"); // DDB free-tier upper
    expect(formatRange(511, "GB-Mo")).toBe("511 GB"); // boundary − 1
  });

  // ── Variation C — count unit (Notifications) ──────────────────────────────
  it("Variation C — count unit (Notifications) renders with k/M suffix + unit name", () => {
    expect(formatRange(1_000_000, "Notifications")).toBe("1M Notifications");
    expect(formatRange(100_000_000, "Notifications")).toBe(
      "100M Notifications",
    );
    expect(formatRange(1_500_000, "Notifications")).toBe("1.5M Notifications");
  });

  // ── Variation D — count unit (Publishes) ──────────────────────────────────
  it("Variation D — count unit (Publishes) — large counts use B suffix", () => {
    expect(formatRange(1_000_000_000, "Publishes")).toBe("1B Publishes");
    expect(formatRange(98_000_000_000, "Publishes")).toBe("98B Publishes");
    // Was: "98 TB" — PH1-C-3 root cause; now renders the actual count.
  });

  // ── Variation E — compute-second unit (Lambda-GB-Second) ──────────────────
  it("Variation E — compute-second unit renders with M/B suffix + 'GB-Seconds' name", () => {
    expect(formatRange(6_000_000_000, "Lambda-GB-Second")).toBe(
      "6B GB-Seconds",
    );
    expect(formatRange(5_859_375_000, "Lambda-GB-Second")).toBe(
      "5.86B GB-Seconds",
    );
    // Was: "5859375 TB" — PH1-D-3 root cause; now renders the actual compute-second count.
  });

  // ── Variation F — unknown unit fallback ───────────────────────────────────
  it("Variation F — unknown unit renders raw + unit string, NO TB conversion", () => {
    expect(formatRange(123_456, "Unknown")).toBe("123,456 Unknown");
    expect(formatRange(1024, "Widgets")).toBe("1,024 Widgets");
    // Critically: NO "1 TB" rendering even though value ≥ 512.
  });

  // ── Variation G — count boundary at 1k / 1M ───────────────────────────────
  it("Variation G — count boundary cases (k/M/B transitions)", () => {
    expect(formatRange(999, "Requests")).toBe("999 Requests");
    expect(formatRange(1_000, "Requests")).toBe("1k Requests");
    expect(formatRange(999_999, "Requests")).toBe("1M Requests"); // toPrecision rounds k→M
    expect(formatRange(1_000_000, "Requests")).toBe("1M Requests");
    // M→B boundary — same toPrecision promotion at the next tier.
    expect(formatRange(999_999_999, "Publishes")).toBe("1B Publishes"); // toPrecision rounds M→B
    expect(formatRange(1_000_000_000, "Publishes")).toBe("1B Publishes"); // exact 1B
  });

  // ── Variation H — case-insensitive unit family detection ──────────────────
  it("Variation H — unit family detection is case-insensitive", () => {
    expect(formatRange(1_000_000, "REQUESTS")).toBe("1M REQUESTS");
    expect(formatRange(40960, "gb-mo")).toBe("40 TB");
    expect(formatRange(6_000_000_000, "GB-Second")).toBe("6B GB-Seconds");
  });
});
