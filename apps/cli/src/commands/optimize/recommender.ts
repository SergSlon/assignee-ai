/**
 * Recommendation gathering for `assignee optimize`.
 *
 * Wave-6d F4: split from optimize.ts. Two input sources:
 *   1. Pricing-MCP-backed per-resource analyzer (EC2/RDS Graviton swap)
 *   2. Billing MCP (compute-optimizer + cost-optimization hub)
 *
 * Both are merged into a single CostOptRecommendation stream the caller
 * can then sort/filter for display.
 */
import { resolveDesiredState } from "../../utils/resolve-desired-state.js";
import { analyzeResource } from "../../nodes/advice/cost-optimizer/orchestrator.js";
import type { CostOptRecommendation } from "../../nodes/advice/cost-optimizer/types.js";
import {
  queryCostOptimization,
  queryComputeOptimizer,
} from "../../services/billing.js";
import { getBillingMcpToolsAsync } from "../../services/mcp-client.js";
import type { ManagedResource } from "../../services/list-resources.js";
import type { StructuredTool } from "@langchain/core/tools";

export interface GatherResult {
  recommendations: CostOptRecommendation[];
  analyzed: number;
}

export async function gatherRecommendations(
  targets: ManagedResource[],
  tools: StructuredTool[],
): Promise<GatherResult> {
  const allRecommendations: CostOptRecommendation[] = [];
  let analyzed = 0;

  // Per-resource analyzer. Resources without a checkpoint are silently
  // skipped — optimize cannot make a meaningful recommendation without
  // knowing what the user intended to deploy. Track scanned vs analyzed
  // separately so the summary can distinguish the two.
  for (const resource of targets) {
    const desiredState = await resolveDesiredState(resource.arn);
    if (!desiredState) continue;
    analyzed++;
    const recommendation = await analyzeResource(
      { arn: resource.arn, resourceType: resource.resourceType },
      desiredState,
      tools,
    );
    if (recommendation) allRecommendations.push(recommendation);
  }

  // Billing MCP augmentation — parallel, non-blocking. compute-optimizer
  // provides utilization-based rightsizing; cost-optimization surfaces
  // cross-service savings opportunities.
  const billingTools = await getBillingMcpToolsAsync();
  if (billingTools) {
    const [costOptRecs, computeOptRecs] = await Promise.allSettled([
      queryCostOptimization(billingTools),
      queryComputeOptimizer(billingTools),
    ]);

    const coRecs =
      computeOptRecs.status === "fulfilled" ? computeOptRecs.value : [];
    for (const rec of coRecs) {
      if (!rec.resourceArn || !rec.recommendedConfig) continue;
      const savings = parseFloat(rec.estimatedSavings) || 0;
      allRecommendations.push({
        resourceArn: rec.resourceArn,
        resourceType: rec.resourceType,
        currentConfig: rec.currentConfig,
        recommendedConfig: rec.recommendedConfig,
        currentHourly: "N/A",
        recommendedHourly: "N/A",
        monthlySavings: savings > 0 ? `$${savings.toFixed(2)}/mo` : "N/A",
        savingsPercent: 0,
        savingsAbsoluteUsd: savings,
        rationale: `Compute Optimizer: ${rec.finding}`,
        confidence: "high",
      });
    }

    const csRecs = costOptRecs.status === "fulfilled" ? costOptRecs.value : [];
    for (const rec of csRecs) {
      if (!rec.resourceArn) continue;
      const savings = parseFloat(rec.estimatedSavings) || 0;
      allRecommendations.push({
        resourceArn: rec.resourceArn,
        resourceType: rec.resourceType,
        currentConfig: "(current)",
        recommendedConfig: rec.finding,
        currentHourly: "N/A",
        recommendedHourly: "N/A",
        monthlySavings: savings > 0 ? `$${savings.toFixed(2)}/mo` : "N/A",
        savingsPercent: 0,
        savingsAbsoluteUsd: savings,
        rationale: `Cost Optimization Hub: ${rec.finding}`,
        confidence: "medium",
      });
    }
  }

  return { recommendations: allRecommendations, analyzed };
}

/**
 * Filter by --min-savings threshold (absolute USD — not percent — so
 * operators can write predictable "only ≥$50/month" policies), then
 * sort highest-saving first.
 */
export function rankRecommendations(
  all: CostOptRecommendation[],
  minSavingsUsd: number,
): CostOptRecommendation[] {
  const filtered = all.filter((r) => r.savingsAbsoluteUsd >= minSavingsUsd);
  filtered.sort((a, b) => b.savingsAbsoluteUsd - a.savingsAbsoluteUsd);
  return filtered;
}
