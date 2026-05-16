/**
 * Compound-plan cost accumulation integration test — Story 108-B-02.
 *
 * Tests the LangGraph state-accumulation mechanics for `estimatedMonthlyCost`
 * and `pricingBreakdown` across compound plan iterations.
 *
 * Strategy: build a minimal StateGraph (using the REAL `graphAnnotation` with
 * the new accumulator reducers) with a simple "pricing node" that simulates
 * the `preflight-guard` returning per-resource costs. Drive the graph through
 * N iterations and assert that the accumulated state equals the correct sum,
 * not just the Nth resource's cost.
 *
 * PRE-FIX FAILURE EVIDENCE (AC #7): This test was run against the pre-fix
 * reducer `(_, b) => b` to confirm it FAILS:
 *
 *   Before fix — 3-resource plan:
 *     Expected: "$50.00/mo" (sum of $10 + $15 + $25)
 *     Received: "$25.00/mo" (last-write-wins, only RDS cost)
 *
 *   After fix (accumulateCostLabel reducer):
 *     Expected: "$50.00/mo"
 *     Received: "$50.00/mo"  ✓
 *
 * The compound plan graph loop is:
 *   preflight_node → loop_back → preflight_node (×N resources)
 *
 * Axes covered by this file:
 *   C — 3-resource compound plan cost accumulation (primary assertion)
 *   E — pricingBreakdown accumulation (fixedItems preserved, fixedSubtotal summed)
 *   H — Backwards compatibility: pre-existing single-resource tests not broken
 */

import { describe, it, expect } from "vitest";
import { StateGraph, END } from "@langchain/langgraph";
import { graphAnnotation } from "../graph-state.js";
import type { AgentState } from "../graph-state.js";
import type { PricingBreakdown } from "../../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal PricingBreakdown with a single fixed line item.
 * Used to simulate per-resource pricing output from preflight-guard.
 */
function makeMockBreakdown(
  label: string,
  monthlyCost: number,
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
          description: `${label} instance`,
          priceUnit: "/mo",
        },
        unitPrice: `$${monthlyCost.toFixed(4)}`,
        monthlyCost,
        displayPrice: `$${monthlyCost.toFixed(2)}/mo`,
      },
    ],
    usageBasedItems: [],
    fixedSubtotal: monthlyCost,
    fetchedAt: new Date("2026-05-16T10:00:00.000Z").toISOString(),
    hasCacheHits: false,
    hasPartialFailure: false,
  };
}

// Resource specs for the three-tier web app simulation
const THREE_TIER_RESOURCES = [
  { label: "S3", costLabel: "$10.00/mo", monthlyCost: 10 },
  { label: "Lambda", costLabel: "$15.00/mo", monthlyCost: 15 },
  { label: "RDS", costLabel: "$25.00/mo", monthlyCost: 25 },
] as const;

const EXPECTED_TOTAL = 10 + 15 + 25; // 50

// ---------------------------------------------------------------------------
// Minimal compound-plan graph factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal StateGraph using the real `graphAnnotation` (with the
 * accumulator reducers from Story 108-B-02).
 *
 * The graph simulates the preflight-guard loop:
 *   pricing_node → should_continue → (loop back or END)
 *
 * Each call to `pricing_node` simulates one iteration of the compound-plan
 * loop returning `estimatedMonthlyCost` and `pricingBreakdown` for the
 * current resource.
 *
 * @param resources - ordered list of per-resource cost data to emit
 */
function buildCompoundPlanGraph(
  resources: ReadonlyArray<{
    label: string;
    costLabel: string;
    monthlyCost: number;
  }>,
) {
  // Track iteration index outside graph state to drive the loop.
  // In a real graph, this is `state.currentResourceIndex`.
  let iterationIndex = 0;

  const pricingNode = (_state: AgentState): Partial<AgentState> => {
    const resource = resources[iterationIndex]!;
    iterationIndex += 1;
    return {
      estimatedMonthlyCost: resource.costLabel,
      pricingBreakdown: makeMockBreakdown(resource.label, resource.monthlyCost),
    };
  };

  const routeNode = (_state: AgentState): string => {
    return iterationIndex < resources.length ? "pricing_node" : END;
  };

  const workflow = new StateGraph(graphAnnotation)
    .addNode("pricing_node", pricingNode)
    .addConditionalEdges("pricing_node", routeNode)
    .addEdge("__start__", "pricing_node");

  return {
    graph: workflow.compile(),
    resetIterationIndex: () => {
      iterationIndex = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compound-plan cost accumulation (Story 108-B-02)", () => {
  // Axis C — 3-resource compound plan: total = resource-1 + resource-2 + resource-3
  describe("Axis C — 3-resource three-tier web app (S3 + Lambda + RDS)", () => {
    it("final estimatedMonthlyCost equals sum of all 3 resources, not just the 3rd", async () => {
      // PRE-FIX FAILURE EVIDENCE:
      // With the old reducer `(_, b) => b`, this test produced "$25.00/mo" (RDS only).
      // With the new accumulator reducer, it produces "$50.00/mo" (correct total).
      const { graph } = buildCompoundPlanGraph(THREE_TIER_RESOURCES);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "compound-cost-3-resources" } },
      );

      expect(result.estimatedMonthlyCost).toBe(
        `$${EXPECTED_TOTAL.toFixed(2)}/mo`,
      );
    });

    it("final estimatedMonthlyCost is NOT equal to only the last resource's cost", async () => {
      const { graph } = buildCompoundPlanGraph(THREE_TIER_RESOURCES);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "compound-cost-not-last-write" } },
      );

      // Verify it's NOT just the last resource's cost (RDS = $25.00/mo)
      expect(result.estimatedMonthlyCost).not.toBe("$25.00/mo");
      // And NOT just S3 or Lambda
      expect(result.estimatedMonthlyCost).not.toBe("$10.00/mo");
      expect(result.estimatedMonthlyCost).not.toBe("$15.00/mo");
    });
  });

  // Axis E — pricingBreakdown accumulation: all N fixedItems preserved
  describe("Axis E — pricingBreakdown accumulates all per-resource line items", () => {
    it("fixedItems length equals number of resources after 3 iterations", async () => {
      const { graph } = buildCompoundPlanGraph(THREE_TIER_RESOURCES);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "compound-breakdown-3-resources" } },
      );

      expect(result.pricingBreakdown).toBeDefined();
      // All 3 resources' line items must be in the final breakdown
      expect(result.pricingBreakdown!.fixedItems).toHaveLength(3);
    });

    it("fixedSubtotal equals sum of all resource costs", async () => {
      const { graph } = buildCompoundPlanGraph(THREE_TIER_RESOURCES);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "compound-breakdown-subtotal" } },
      );

      expect(result.pricingBreakdown!.fixedSubtotal).toBe(EXPECTED_TOTAL);
    });

    it("all per-resource line item labels are preserved (not overwritten)", async () => {
      const { graph } = buildCompoundPlanGraph(THREE_TIER_RESOURCES);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "compound-breakdown-labels" } },
      );

      const labels = result.pricingBreakdown!.fixedItems.map(
        (item) => item.lineItem.label,
      );
      expect(labels).toContain("S3");
      expect(labels).toContain("Lambda");
      expect(labels).toContain("RDS");
    });
  });

  // Axis A — Single-resource: no double-counting
  describe("Axis A — single-resource plan (backwards compatibility)", () => {
    it("single-resource plan: estimatedMonthlyCost equals that resource's cost exactly", async () => {
      const singleResource = [THREE_TIER_RESOURCES[0]!] as const;
      const { graph } = buildCompoundPlanGraph(singleResource);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "single-resource-no-double-count" } },
      );

      // Must equal exactly $10.00/mo — not double-counted
      expect(result.estimatedMonthlyCost).toBe("$10.00/mo");
    });

    it("single-resource pricingBreakdown has exactly 1 fixedItem", async () => {
      const singleResource = [THREE_TIER_RESOURCES[0]!] as const;
      const { graph } = buildCompoundPlanGraph(singleResource);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "single-resource-breakdown-length" } },
      );

      expect(result.pricingBreakdown!.fixedItems).toHaveLength(1);
    });
  });

  // Axis B — 2-resource compound plan
  describe("Axis B — 2-resource compound plan", () => {
    it("2-resource plan: final cost = resource-1 + resource-2", async () => {
      const twoResources = [
        THREE_TIER_RESOURCES[0]!,
        THREE_TIER_RESOURCES[1]!,
      ] as const;
      const { graph } = buildCompoundPlanGraph(twoResources);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "two-resource-cost" } },
      );

      // $10.00 (S3) + $15.00 (Lambda) = $25.00
      expect(result.estimatedMonthlyCost).toBe("$25.00/mo");
    });
  });

  // Zero-cost resource in compound plan
  describe("Axis D — compound plan with a zero-cost resource", () => {
    it("zero-cost resource does not corrupt accumulated total", async () => {
      const resourcesWithZeroCost = [
        { label: "EC2", costLabel: "$10.00/mo", monthlyCost: 10 },
        { label: "IAM", costLabel: "$0.00/mo", monthlyCost: 0 },
        { label: "RDS", costLabel: "$25.00/mo", monthlyCost: 25 },
      ] as const;
      const { graph } = buildCompoundPlanGraph(resourcesWithZeroCost);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "compound-with-zero-cost" } },
      );

      // $10 + $0 + $25 = $35
      expect(result.estimatedMonthlyCost).toBe("$35.00/mo");
    });
  });

  // Accumulator correctness: value grows monotonically
  describe("accumulator monotonicity", () => {
    it("each successive iteration adds to the total (not replaces it)", async () => {
      // Use a 3-resource plan but verify the intermediate step conceptually:
      // after 2 resources, cost should be > cost of 1st resource alone.
      const { graph } = buildCompoundPlanGraph(THREE_TIER_RESOURCES);

      const result = await graph.invoke(
        {},
        { configurable: { thread_id: "compound-cost-monotone" } },
      );

      // Final total must be greater than any individual resource cost
      const totalMatch = /^\$(\d+\.\d{2})\/mo$/.exec(
        result.estimatedMonthlyCost ?? "",
      );
      expect(totalMatch).not.toBeNull();
      const totalValue = parseFloat(totalMatch![1]!);
      expect(totalValue).toBeGreaterThan(10); // > S3 alone
      expect(totalValue).toBeGreaterThan(15); // > Lambda alone
      expect(totalValue).toBeGreaterThan(25); // > RDS alone
      expect(totalValue).toBe(EXPECTED_TOTAL); // = correct total
    });
  });
});
