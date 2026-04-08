import { describe, it, expect } from "vitest";
import { eventsRulePricingStrategy } from "./events-rule.js";
import { CostEstimateLabel } from "../filter-constants.js";

describe("eventsRulePricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns free for the default bus when EventBusName is unset", () => {
      const estimate = eventsRulePricingStrategy.estimateLocal!({});
      expect(estimate.perMonth).toBe(0);
      expect(estimate.isFree).toBe(true);
      expect(estimate.label).toBe(CostEstimateLabel.FREE);
    });

    it("returns free when EventBusName is explicitly 'default'", () => {
      const estimate = eventsRulePricingStrategy.estimateLocal!({
        EventBusName: "default",
      });
      expect(estimate.perMonth).toBe(0);
      expect(estimate.isFree).toBe(true);
    });

    it("returns free when EventBusName is whitespace (normalizes to default)", () => {
      const estimate = eventsRulePricingStrategy.estimateLocal!({
        EventBusName: "  ",
      });
      expect(estimate.perMonth).toBe(0);
      expect(estimate.isFree).toBe(true);
    });

    it("returns null perMonth + NA label for a custom bus", () => {
      const estimate = eventsRulePricingStrategy.estimateLocal!({
        EventBusName: "my-custom-bus",
      });
      expect(estimate.perMonth).toBeNull();
      expect(estimate.label).toBe(CostEstimateLabel.NA);
      expect(estimate.isFree).toBeUndefined();
    });

    it("non-string EventBusName falls back to default (treated as free)", () => {
      const estimate = eventsRulePricingStrategy.estimateLocal!({
        EventBusName: 42,
      });
      expect(estimate.perMonth).toBe(0);
      expect(estimate.isFree).toBe(true);
    });

    it("handles undefined desiredState as free (default bus)", () => {
      const estimate = eventsRulePricingStrategy.estimateLocal!(undefined);
      expect(estimate.perMonth).toBe(0);
      expect(estimate.isFree).toBe(true);
    });
  });
});
