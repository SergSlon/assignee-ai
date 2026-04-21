/**
 * Tests for ELBv2 pricing decomposer.
 *
 * Verifies line item generation for ALB and NLB load balancers. Story
 * 92.1.e adds `usagetype` filter pinning (`LoadBalancerUsage` for
 * hourly, `LCUUsage` for LCU) so the Pricing API fetch resolves to the
 * correct row every time — previously the single `productFamily` filter
 * could match either the hourly OR the LCU row non-deterministically,
 * producing the noisy `pricing_unavailable advisoryPriceId=alb-monthly`
 * warnings cited by findings A-05 / B-08 / B-19 / C-08 / C-21 / D-17.
 */

import { describe, it, expect } from "vitest";
import { elbv2PricingDecomposer } from "./elbv2.js";
import { extractFirstTierPrice } from "../mcp-parser.js";
import { unwrapMcpText } from "../../utils/mcp.js";
import type { AwsPricingResponse } from "../types.js";
import { elbv2AlbHourly } from "../../test-fixtures/mcp-mock-responses/pricing-elbv2.js";
import { HOURS_PER_MONTH } from "../../config/constants/limits.js";

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

  // ── Story 92.1.e: filter-shape pinning ─────────────────────────────────
  //
  // The previous suite asserted "LCU/NLCU items use productFamily filter
  // (no usagetype)" — that assertion pinned the BUG behaviour cited in
  // findings A-05 / B-08 / B-19 / C-08 / C-21 / D-17 (ALB fetch never
  // resolved because the family returned multiple rows). The correct
  // semantic is: both filters present, so the Pricing API returns a
  // single deterministic row.
  it("ALB hourly pins productFamily=Load Balancer-Application AND usagetype=LoadBalancerUsage", () => {
    const items = elbv2PricingDecomposer.decompose({});
    const hourly = items.find((i) => i.label === "Hourly")!;

    const productFamily = hourly.filters.find(
      (f) => f.Field === "productFamily",
    );
    const usagetype = hourly.filters.find((f) => f.Field === "usagetype");

    expect(productFamily?.Value).toBe("Load Balancer-Application");
    expect(usagetype?.Value).toBe("LoadBalancerUsage");
  });

  it("ALB LCU pins productFamily=Load Balancer-Application AND usagetype=LCUUsage", () => {
    const items = elbv2PricingDecomposer.decompose({});
    const lcu = items.find((i) => i.label === "LCU")!;

    const productFamily = lcu.filters.find((f) => f.Field === "productFamily");
    const usagetype = lcu.filters.find((f) => f.Field === "usagetype");

    expect(productFamily?.Value).toBe("Load Balancer-Application");
    expect(usagetype?.Value).toBe("LCUUsage");
  });

  it("NLB hourly pins productFamily=Load Balancer-Network AND usagetype=LoadBalancerUsage", () => {
    const items = elbv2PricingDecomposer.decompose({ Type: "network" });
    const hourly = items.find((i) => i.label === "Hourly")!;

    const productFamily = hourly.filters.find(
      (f) => f.Field === "productFamily",
    );
    const usagetype = hourly.filters.find((f) => f.Field === "usagetype");

    expect(productFamily?.Value).toBe("Load Balancer-Network");
    expect(usagetype?.Value).toBe("LoadBalancerUsage");
  });

  it("NLB LCU pins productFamily=Load Balancer-Network AND usagetype=LCUUsage", () => {
    const items = elbv2PricingDecomposer.decompose({ Type: "network" });
    const nlcu = items.find((i) => i.label === "NLCU")!;

    const productFamily = nlcu.filters.find((f) => f.Field === "productFamily");
    const usagetype = nlcu.filters.find((f) => f.Field === "usagetype");

    expect(productFamily?.Value).toBe("Load Balancer-Network");
    expect(usagetype?.Value).toBe("LCUUsage");
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
    expect(items[0]!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "usagetype",
          Value: "LoadBalancerUsage",
        }),
      ]),
    );
  });

  // ── Story 92.1.e: live-fetch parity pin ────────────────────────────────
  //
  // The decomposer's filters must round-trip through
  // `extractFirstTierPrice` against the captured AWS Pricing API
  // response for ALB (0.0225/hr → 16.43/mo). This is the regression
  // pin cited in the story's acceptance criteria: "ALB monthly ~$16/mo
  // against a real pricing-MCP response fixture".
  it("ALB hourly filter resolves to ~$16.43/mo against real AWS Pricing API fixture", () => {
    const items = elbv2PricingDecomposer.decompose({});
    const hourly = items.find((i) => i.label === "Hourly")!;

    const rawResponse = elbv2AlbHourly.success;
    const data = JSON.parse(unwrapMcpText(rawResponse)) as AwsPricingResponse;
    const extracted = extractFirstTierPrice(data, "/hour", 1, hourly.filters);

    expect(extracted).not.toBeNull();
    // `extractFirstTierPrice` returns "$0.0225/hour" for the ALB fixture.
    const match = extracted!.match(/\$(\d+(?:\.\d+)?)/);
    expect(match).not.toBeNull();
    const hourlyRate = Number.parseFloat(match![1]!);
    expect(hourlyRate).toBeCloseTo(0.0225, 4);

    // 0.0225 × 730 = 16.425 → ~$16/mo. This is the pin: the old
    // filter-less fetch failed to resolve; the fixed filter lands on
    // this row every time.
    const monthly = hourlyRate * HOURS_PER_MONTH;
    expect(monthly).toBeCloseTo(16.43, 1);
  });
});
