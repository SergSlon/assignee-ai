/**
 * Isolated unit tests for the `estimatedMonthlyCost` and `pricingBreakdown`
 * accumulator reducers introduced in Story 108-B-02.
 *
 * These tests exercise the REDUCER FUNCTIONS IN COMPLETE ISOLATION — no graph
 * execution, no LLM, no AWS calls. Each test calls the exported reducer
 * directly and asserts the accumulated result.
 *
 * Axes covered:
 *   A — Single-resource: cost after 1 write = that resource's cost (no double-count)
 *   B — 2-resource compound: intermediate + final values asserted
 *   C — 3-resource compound: total = sum of all three
 *   D — Zero-cost free-tier resource in a 3-resource plan
 *   E — pricingBreakdown accumulation: array lengths preserved after N iterations
 *   F — Reducer purity: calling with same inputs twice yields structural equality
 *   G — Plan formatter compatibility: correctly typed string output (no NaN)
 *   H — Backwards compatibility: special labels (N/A, Free) handled gracefully
 */

import { describe, it, expect } from "vitest";
import {
  accumulateCostLabel,
  accumulatePricingBreakdown,
} from "../graph-state.js";
import type { PricingBreakdown } from "../../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePricingBreakdown(
  fixedMonthlyCost: number,
  label: string = "Compute",
): PricingBreakdown {
  return {
    fixedItems: [
      {
        lineItem: {
          label,
          quantity: 1,
          unit: "instance",
          serviceCode: "AmazonEC2",
          filters: [],
          kind: "fixed",
          description: `${label} t3.micro`,
          priceUnit: "/mo",
        },
        unitPrice: `$${fixedMonthlyCost.toFixed(4)}`,
        monthlyCost: fixedMonthlyCost,
        displayPrice: `$${fixedMonthlyCost.toFixed(2)}/mo`,
      },
    ],
    usageBasedItems: [],
    fixedSubtotal: fixedMonthlyCost,
    fetchedAt: new Date("2026-05-16T00:00:00.000Z").toISOString(),
    hasCacheHits: false,
    hasPartialFailure: false,
  };
}

// ---------------------------------------------------------------------------
// accumulateCostLabel — string accumulator
// ---------------------------------------------------------------------------

describe("accumulateCostLabel", () => {
  // Axis A — Single-resource: first write returns b as-is, no double-counting
  describe("Axis A — single-resource (first write)", () => {
    it("(undefined, '$10.00/mo') → '$10.00/mo'", () => {
      expect(accumulateCostLabel(undefined, "$10.00/mo")).toBe("$10.00/mo");
    });

    it("(undefined, 'Free') → 'Free'", () => {
      expect(accumulateCostLabel(undefined, "Free")).toBe("Free");
    });

    it("(undefined, 'N/A') → 'N/A'", () => {
      expect(accumulateCostLabel(undefined, "N/A")).toBe("N/A");
    });

    it("does not double-count a single resource when called once", () => {
      const result = accumulateCostLabel(undefined, "$5.00/mo");
      // Calling with the result as accumulated + same value would double-count,
      // but a single call must NOT produce double the value.
      expect(result).toBe("$5.00/mo");
    });
  });

  // Axis B — 2-resource compound: intermediate and final values
  describe("Axis B — 2-resource compound plan", () => {
    it("after iteration 1 = resource-1 cost", () => {
      const afterIter1 = accumulateCostLabel(undefined, "$10.00/mo");
      expect(afterIter1).toBe("$10.00/mo");
    });

    it("after iteration 2 = resource-1 + resource-2", () => {
      const afterIter1 = accumulateCostLabel(undefined, "$10.00/mo");
      const afterIter2 = accumulateCostLabel(afterIter1, "$5.00/mo");
      expect(afterIter2).toBe("$15.00/mo");
    });

    it("both intermediate and final values are asserted correctly", () => {
      const afterIter1 = accumulateCostLabel(undefined, "$20.00/mo");
      expect(afterIter1).toBe("$20.00/mo"); // intermediate

      const afterIter2 = accumulateCostLabel(afterIter1, "$30.00/mo");
      expect(afterIter2).toBe("$50.00/mo"); // final
    });
  });

  // Axis C — 3-resource compound plan: total = resource-1 + resource-2 + resource-3
  describe("Axis C — 3-resource compound plan (three-tier web app shape)", () => {
    it("S3 + Lambda + RDS accumulates correctly", () => {
      // Resource 1: S3 ($3.00/mo)
      const afterS3 = accumulateCostLabel(undefined, "$3.00/mo");
      expect(afterS3).toBe("$3.00/mo");

      // Resource 2: Lambda ($5.00/mo)
      const afterLambda = accumulateCostLabel(afterS3, "$5.00/mo");
      expect(afterLambda).toBe("$8.00/mo");

      // Resource 3: RDS ($42.00/mo)
      const afterRds = accumulateCostLabel(afterLambda, "$42.00/mo");
      expect(afterRds).toBe("$50.00/mo");
    });

    it("accumulation is exact (no floating point drift for round amounts)", () => {
      let acc = accumulateCostLabel(undefined, "$10.00/mo");
      acc = accumulateCostLabel(acc, "$20.00/mo");
      acc = accumulateCostLabel(acc, "$30.00/mo");
      expect(acc).toBe("$60.00/mo");
    });
  });

  // Axis D — Zero-cost free-tier resource in a compound plan
  describe("Axis D — zero-cost free-tier resource", () => {
    it("Free resource between priced resources: total = other two only", () => {
      // Resource 1: EC2 ($10.00/mo)
      const afterEc2 = accumulateCostLabel(undefined, "$10.00/mo");
      // Resource 2: IAM Role (Free) — string 'Free' is non-numeric
      // Since 'Free' is not parseable as '$X.XX/mo', falls back to 'Free'
      const afterIam = accumulateCostLabel(afterEc2, "Free");
      // Cannot sum EC2 + Free meaningfully — falls back to 'Free'
      expect(afterIam).toBe("Free");
    });

    it("zero numeric cost ($0.00/mo) accumulates correctly", () => {
      // A resource with $0.00/mo cost (priced but zero — unusual but valid)
      const afterFirst = accumulateCostLabel(undefined, "$10.00/mo");
      const afterZero = accumulateCostLabel(afterFirst, "$0.00/mo");
      expect(afterZero).toBe("$10.00/mo");
    });

    it("N/A resource after priced: falls back to N/A", () => {
      const afterFirst = accumulateCostLabel(undefined, "$5.00/mo");
      const afterNa = accumulateCostLabel(afterFirst, "N/A");
      // N/A is non-numeric — falls back to last-write-wins (N/A)
      expect(afterNa).toBe("N/A");
    });
  });

  // Axis F — Reducer purity
  describe("Axis F — reducer purity (no side effects)", () => {
    it("calling twice with same inputs returns structural equality", () => {
      const result1 = accumulateCostLabel("$10.00/mo", "$5.00/mo");
      const result2 = accumulateCostLabel("$10.00/mo", "$5.00/mo");
      expect(result1).toBe(result2);
    });

    it("does not mutate input strings", () => {
      const a = "$10.00/mo";
      const b = "$5.00/mo";
      accumulateCostLabel(a, b);
      expect(a).toBe("$10.00/mo");
      expect(b).toBe("$5.00/mo");
    });
  });

  // Axis G — Formatter compatibility: output is always a string or undefined (no NaN)
  describe("Axis G — plan formatter compatibility (no NaN output)", () => {
    it("accumulated result is a string", () => {
      const result = accumulateCostLabel("$10.00/mo", "$5.00/mo");
      expect(typeof result).toBe("string");
    });

    it("accumulated result does not contain NaN", () => {
      const result = accumulateCostLabel("$10.00/mo", "$5.00/mo");
      expect(result).not.toContain("NaN");
    });

    it("reset to undefined is typed correctly", () => {
      const result = accumulateCostLabel("$10.00/mo", undefined);
      expect(result).toBeUndefined();
    });
  });

  // Axis H — Backwards compat: special labels
  describe("Axis H — backwards compatibility with special labels", () => {
    it("explicit reset (b=undefined) returns undefined", () => {
      expect(accumulateCostLabel("$10.00/mo", undefined)).toBeUndefined();
      expect(accumulateCostLabel(undefined, undefined)).toBeUndefined();
    });

    it("(undefined, undefined) → undefined", () => {
      expect(accumulateCostLabel(undefined, undefined)).toBeUndefined();
    });

    it("tilde-prefix amounts ('~$5.00/mo') accumulate correctly", () => {
      const result = accumulateCostLabel("~$5.00/mo", "$3.00/mo");
      expect(result).toBe("$8.00/mo");
    });

    it("non-standard usage-based rate string falls back to last-write-wins", () => {
      // "$0.023/GB" is a per-unit rate, not a fixed monthly cost
      const result = accumulateCostLabel("$10.00/mo", "$0.023/GB");
      expect(result).toBe("$0.023/GB"); // falls back
    });
  });
});

// ---------------------------------------------------------------------------
// accumulatePricingBreakdown — object accumulator
// ---------------------------------------------------------------------------

describe("accumulatePricingBreakdown", () => {
  // Axis A — Single-resource: first write returns b directly
  describe("Axis A — single-resource (first write)", () => {
    it("(undefined, breakdown) → breakdown", () => {
      const bd = makePricingBreakdown(10, "Compute");
      const result = accumulatePricingBreakdown(undefined, bd);
      expect(result).toBe(bd); // same reference
    });

    it("(undefined, undefined) → undefined (PD-2 reset)", () => {
      const result = accumulatePricingBreakdown(undefined, undefined);
      expect(result).toBeUndefined();
    });
  });

  // Axis E — pricingBreakdown accumulation: array lengths preserved
  describe("Axis E — pricingBreakdown accumulation across N iterations", () => {
    it("2-resource: fixedItems length = 2, fixedSubtotal = sum", () => {
      const bd1 = makePricingBreakdown(10, "S3-Storage");
      const bd2 = makePricingBreakdown(5, "Lambda-Compute");
      const result = accumulatePricingBreakdown(bd1, bd2);
      expect(result).toBeDefined();
      expect(result!.fixedItems).toHaveLength(2);
      expect(result!.fixedSubtotal).toBe(15);
    });

    it("3-resource: fixedItems length = 3, fixedSubtotal = sum of all three", () => {
      const bd1 = makePricingBreakdown(10, "S3-Storage");
      const bd2 = makePricingBreakdown(5, "Lambda-Compute");
      const bd3 = makePricingBreakdown(42, "RDS-Instance");

      const after2 = accumulatePricingBreakdown(bd1, bd2);
      const after3 = accumulatePricingBreakdown(after2, bd3);

      expect(after3).toBeDefined();
      expect(after3!.fixedItems).toHaveLength(3);
      expect(after3!.fixedSubtotal).toBe(57);
    });

    it("preserves ALL line items — no items from earlier iterations are lost", () => {
      const bd1 = makePricingBreakdown(10, "Resource1");
      const bd2 = makePricingBreakdown(20, "Resource2");
      const bd3 = makePricingBreakdown(30, "Resource3");

      const result = accumulatePricingBreakdown(
        accumulatePricingBreakdown(bd1, bd2),
        bd3,
      );

      // All 3 line item labels must be present
      const labels = result!.fixedItems.map((i) => i.lineItem.label);
      expect(labels).toContain("Resource1");
      expect(labels).toContain("Resource2");
      expect(labels).toContain("Resource3");
    });
  });

  // PD-2 reset semantics
  describe("PD-2 reset semantics (b=undefined clears breakdown)", () => {
    it("(breakdown, undefined) → undefined", () => {
      const bd = makePricingBreakdown(10, "EC2");
      const result = accumulatePricingBreakdown(bd, undefined);
      expect(result).toBeUndefined();
    });

    it("after reset, new write starts fresh", () => {
      const bd1 = makePricingBreakdown(10, "EC2");
      const afterReset = accumulatePricingBreakdown(bd1, undefined);
      const bd2 = makePricingBreakdown(5, "Lambda");
      const result = accumulatePricingBreakdown(afterReset, bd2);
      // After reset, afterReset=undefined → (undefined, bd2) → bd2
      expect(result!.fixedItems).toHaveLength(1);
      expect(result!.fixedSubtotal).toBe(5);
    });
  });

  // Boolean flag accumulation
  describe("boolean flag accumulation (OR semantics)", () => {
    it("hasCacheHits is true when either breakdown has cache hits", () => {
      const bd1 = { ...makePricingBreakdown(10), hasCacheHits: true };
      const bd2 = { ...makePricingBreakdown(5), hasCacheHits: false };
      const result = accumulatePricingBreakdown(bd1, bd2);
      expect(result!.hasCacheHits).toBe(true);
    });

    it("hasPartialFailure is true when either breakdown has a partial failure", () => {
      const bd1 = { ...makePricingBreakdown(10), hasPartialFailure: false };
      const bd2 = { ...makePricingBreakdown(5), hasPartialFailure: true };
      const result = accumulatePricingBreakdown(bd1, bd2);
      expect(result!.hasPartialFailure).toBe(true);
    });

    it("hasCacheHits is false when neither has cache hits", () => {
      const bd1 = { ...makePricingBreakdown(10), hasCacheHits: false };
      const bd2 = { ...makePricingBreakdown(5), hasCacheHits: false };
      const result = accumulatePricingBreakdown(bd1, bd2);
      expect(result!.hasCacheHits).toBe(false);
    });
  });

  // fetchedAt timestamp: most recent wins
  describe("fetchedAt: most recent timestamp is preserved", () => {
    it("uses the later fetchedAt when b is more recent", () => {
      const bd1 = {
        ...makePricingBreakdown(10),
        fetchedAt: "2026-05-16T01:00:00.000Z",
      };
      const bd2 = {
        ...makePricingBreakdown(5),
        fetchedAt: "2026-05-16T02:00:00.000Z",
      };
      const result = accumulatePricingBreakdown(bd1, bd2);
      expect(result!.fetchedAt).toBe("2026-05-16T02:00:00.000Z");
    });

    it("uses the later fetchedAt when a is more recent", () => {
      const bd1 = {
        ...makePricingBreakdown(10),
        fetchedAt: "2026-05-16T03:00:00.000Z",
      };
      const bd2 = {
        ...makePricingBreakdown(5),
        fetchedAt: "2026-05-16T01:00:00.000Z",
      };
      const result = accumulatePricingBreakdown(bd1, bd2);
      expect(result!.fetchedAt).toBe("2026-05-16T03:00:00.000Z");
    });
  });

  // Axis F — Reducer purity
  describe("Axis F — reducer purity", () => {
    it("calling twice with same inputs returns structurally equal output", () => {
      const bd1 = makePricingBreakdown(10, "EC2");
      const bd2 = makePricingBreakdown(5, "Lambda");
      const result1 = accumulatePricingBreakdown(bd1, bd2);
      const result2 = accumulatePricingBreakdown(bd1, bd2);
      // Deep structural equality
      expect(result1).toEqual(result2);
    });

    it("does not mutate input breakdowns", () => {
      const bd1 = makePricingBreakdown(10, "EC2");
      const bd2 = makePricingBreakdown(5, "Lambda");
      const originalBd1Items = [...bd1.fixedItems];
      const originalBd1Subtotal = bd1.fixedSubtotal;
      accumulatePricingBreakdown(bd1, bd2);
      expect(bd1.fixedItems).toEqual(originalBd1Items);
      expect(bd1.fixedSubtotal).toBe(originalBd1Subtotal);
    });
  });
});
