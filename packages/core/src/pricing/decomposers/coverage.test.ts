/**
 * Coverage integration test — verifies all 25 resource types have
 * pricing strategies and decomposers registered.
 *
 * This test will catch regressions when new types are added to
 * SUPPORTED_TYPES_ARRAY without corresponding pricing support.
 *
 * @see Story 40.5
 */

import { describe, it, expect } from "vitest";
import { SUPPORTED_TYPES_ARRAY } from "../../config/resource-types.js";
import { defaultPricingRegistry, defaultDecomposerRegistry } from "../index.js";

// Note: The PricingStrategyRegistry does not expose a `has()` method —
// it only has `estimate(resourceType, desiredState)`.
// We call estimate() with undefined desiredState and check it returns a non-empty label.
// The PricingDecomposerRegistry has `has()`.

describe("pricing coverage — all 25 resource types", () => {
  it("SUPPORTED_TYPES_ARRAY has exactly 25 types", () => {
    expect(SUPPORTED_TYPES_ARRAY).toHaveLength(25);
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
