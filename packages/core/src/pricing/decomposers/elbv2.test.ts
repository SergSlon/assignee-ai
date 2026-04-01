/**
 * Tests for ELBv2 pricing decomposer.
 * Verifies line item generation for ALB and NLB load balancers.
 */

import { describe, it, expect } from "vitest";
import { elbv2PricingDecomposer } from "./elbv2.js";

describe("elbv2PricingDecomposer", () => {
  it("has correct resourceType", () => {
    expect(elbv2PricingDecomposer.resourceType).toBe(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
  });

  it("returns 2 ALB items when no Type is specified", () => {
    const items = elbv2PricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items[0]!.description).toBe("Application Load Balancer");
    expect(items[0]!.unit).toBe("ALB");
    expect(items[1]!.unit).toBe("LCU-hr");
  });

  it("returns ALB items when Type is 'application'", () => {
    const items = elbv2PricingDecomposer.decompose({ Type: "application" });

    expect(items).toHaveLength(2);
    expect(items[0]!.description).toBe("Application Load Balancer");
    expect(items[0]!.unit).toBe("ALB");
    expect(items[1]!.description).toBe("LCU-hours");
    expect(items[1]!.unit).toBe("LCU-hr");
  });

  it("returns NLB items when Type is 'network'", () => {
    const items = elbv2PricingDecomposer.decompose({ Type: "network" });

    expect(items).toHaveLength(2);
    expect(items[0]!.description).toBe("Network Load Balancer");
    expect(items[0]!.unit).toBe("NLB");
    expect(items[1]!.description).toBe("NLCU-hours");
    expect(items[1]!.unit).toBe("NLCU-hr");
  });

  it("hourly item is 'fixed' with quantity 1", () => {
    const albItems = elbv2PricingDecomposer.decompose({});
    const albHourly = albItems.find((i) => i.label === "Hourly")!;
    expect(albHourly.kind).toBe("fixed");
    expect(albHourly.quantity).toBe(1);

    const nlbItems = elbv2PricingDecomposer.decompose({ Type: "network" });
    const nlbHourly = nlbItems.find((i) => i.label === "Hourly")!;
    expect(nlbHourly.kind).toBe("fixed");
    expect(nlbHourly.quantity).toBe(1);
  });

  it("LCU/NLCU item is 'usage_based' with quantity 0", () => {
    const albItems = elbv2PricingDecomposer.decompose({});
    const lcu = albItems.find((i) => i.label === "LCU")!;
    expect(lcu.kind).toBe("usage_based");
    expect(lcu.quantity).toBe(0);

    const nlbItems = elbv2PricingDecomposer.decompose({ Type: "network" });
    const nlcu = nlbItems.find((i) => i.label === "NLCU")!;
    expect(nlcu.kind).toBe("usage_based");
    expect(nlcu.quantity).toBe(0);
  });

  it("all filters use TERM_MATCH", () => {
    const albItems = elbv2PricingDecomposer.decompose({});
    for (const item of albItems) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }

    const nlbItems = elbv2PricingDecomposer.decompose({ Type: "network" });
    for (const item of nlbItems) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("returns NLB items when Type is 'Network' (capital N, case-insensitive)", () => {
    const items = elbv2PricingDecomposer.decompose({ Type: "Network" });

    expect(items).toHaveLength(2);
    expect(items[0]!.description).toBe("Network Load Balancer");
    expect(items[0]!.unit).toBe("NLB");
    expect(items[1]!.description).toBe("NLCU-hours");
    expect(items[1]!.unit).toBe("NLCU-hr");
  });

  it("LCU/NLCU items use productFamily filter (no usagetype)", () => {
    const albItems = elbv2PricingDecomposer.decompose({});
    const lcu = albItems.find((i) => i.label === "LCU")!;
    const lcuFilterFields = lcu.filters.map((f) => f.Field);
    expect(lcuFilterFields).toContain("productFamily");
    expect(lcuFilterFields).not.toContain("usagetype");

    const nlbItems = elbv2PricingDecomposer.decompose({ Type: "network" });
    const nlcu = nlbItems.find((i) => i.label === "NLCU")!;
    const nlcuFilterFields = nlcu.filters.map((f) => f.Field);
    expect(nlcuFilterFields).toContain("productFamily");
    expect(nlcuFilterFields).not.toContain("usagetype");
  });

  it("handles empty desiredState", () => {
    const items = elbv2PricingDecomposer.decompose({});

    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("Hourly");
    expect(items[1]!.label).toBe("LCU");
    expect(items[0]!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "Load Balancer-Application",
        }),
      ]),
    );
  });
});
