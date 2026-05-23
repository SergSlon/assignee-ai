import { describe, it, expect } from "vitest";
import { isPerUnitRate, PER_UNIT_RATE_PATTERNS } from "./per-unit-rate.js";

/**
 * Shared per-unit-rate detection used by bulk-destroy (F6), admin list
 * (F16), and admin status (F19) to keep their sum-output wording aligned.
 *
 * @see _backlog/wizard-ux-audit-2026-05-22.md F6 / F16 / F19
 */
describe("isPerUnitRate", () => {
  describe("matches per-unit rates", () => {
    it("matches per-GB-month rate ('$0.0230/GB-month')", () => {
      expect(isPerUnitRate("$0.0230/GB-month")).toBe(true);
    });

    it("matches per-GB rate ('$0.09/GB')", () => {
      expect(isPerUnitRate("$0.09/GB")).toBe(true);
    });

    it("matches per-request rate ('$0.0004/request')", () => {
      expect(isPerUnitRate("$0.0004/request")).toBe(true);
    });

    it("matches per-req short form ('$0.0004/req')", () => {
      expect(isPerUnitRate("$0.0004/req")).toBe(true);
    });

    it("matches per-1000-requests rate ('$0.40/1000 requests')", () => {
      expect(isPerUnitRate("$0.40/1000 requests")).toBe(true);
    });

    it("matches per-1k-reqs rate ('$0.40/1k reqs')", () => {
      expect(isPerUnitRate("$0.40/1k reqs")).toBe(true);
    });

    it("matches per-invocation rate ('$0.0000002/invocation')", () => {
      expect(isPerUnitRate("$0.0000002/invocation")).toBe(true);
    });

    it("matches per-call rate ('$0.50/call')", () => {
      expect(isPerUnitRate("$0.50/call")).toBe(true);
    });

    it("matches per-exec rate ('$0.001/exec')", () => {
      expect(isPerUnitRate("$0.001/exec")).toBe(true);
    });

    it("is case-insensitive (matches uppercase)", () => {
      expect(isPerUnitRate("$0.0230/GB-MONTH")).toBe(true);
      expect(isPerUnitRate("$0.40/1000 REQUESTS")).toBe(true);
    });
  });

  describe("does NOT match flat amounts or non-cost strings", () => {
    it("does NOT match per-month flat amount ('$7.59/month')", () => {
      expect(isPerUnitRate("$7.59/month")).toBe(false);
    });

    it("does NOT match per-month short form ('$7.59/mo')", () => {
      expect(isPerUnitRate("$7.59/mo")).toBe(false);
    });

    it("does NOT match per-hour amount ('$0.0104/hr')", () => {
      // Hourly rates are still a flat amount per time, just not monthly.
      // Caller is responsible for converting (× 730) — not "variable".
      expect(isPerUnitRate("$0.0104/hr")).toBe(false);
    });

    it("does NOT match bare amount ('$1.23')", () => {
      expect(isPerUnitRate("$1.23")).toBe(false);
    });

    it("does NOT match 'N/A'", () => {
      expect(isPerUnitRate("N/A")).toBe(false);
    });

    it("does NOT match 'Free'", () => {
      expect(isPerUnitRate("Free")).toBe(false);
    });

    it("does NOT match empty string", () => {
      expect(isPerUnitRate("")).toBe(false);
    });

    it("does NOT match prose mentioning 'GB' without a rate-suffix shape", () => {
      // The /GB regex requires a leading slash to avoid matching
      // arbitrary uses of "GB" in prose.
      expect(isPerUnitRate("Uses 5 GB of storage")).toBe(false);
    });
  });

  describe("constant export", () => {
    it("exports PER_UNIT_RATE_PATTERNS as a non-empty readonly array of RegExp", () => {
      expect(PER_UNIT_RATE_PATTERNS.length).toBeGreaterThan(0);
      for (const re of PER_UNIT_RATE_PATTERNS) {
        expect(re).toBeInstanceOf(RegExp);
      }
    });
  });
});
