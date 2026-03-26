import { describe, it, expect } from "vitest";
import { ecsClusterPricingStrategy } from "./ecs-cluster.js";

describe("ecsClusterPricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns free estimate", () => {
      const result = ecsClusterPricingStrategy.estimateLocal();
      expect(result).toEqual({ perMonth: 0, label: "Free", isFree: true });
    });
  });

  it("has no mcpConfig (ECS clusters are free)", () => {
    expect(ecsClusterPricingStrategy.mcpConfig).toBeUndefined();
  });
});
