/**
 * Recommendation gathering for `assignee infra optimize`.
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
  const total = targets.length;

  // Emit a progress line every ~5 seconds or every 10% of resources,
  // whichever fires first. Filtered from stderr under --json (W5.N3).
  let lastProgressMs = Date.now();
  const PROGRESS_INTERVAL_MS = 5_000;
  const progressStep = Math.max(1, Math.ceil(total / 10));

  const emitProgress = (done: number): void => {
    const eta =
      done > 0
        ? Math.round(
            (((Date.now() - lastProgressMs) / done) * (total - done)) / 1000,
          )
        : "?";
    process.stderr.write(
      `[INFO] Scanning ${total} resources (${done} done, ETA ${eta}s)\n`,
    );
    lastProgressMs = Date.now();
  };

  // Per-resource analyzer. Resources without a checkpoint are silently
  // skipped — optimize cannot make a meaningful recommendation without
  // knowing what the user intended to deploy. Track scanned vs analyzed
  // separately so the summary can distinguish the two.
  for (let i = 0; i < targets.length; i++) {
    const resource = targets[i]!;
    const desiredState = await resolveDesiredState(resource.arn);
    if (!desiredState) continue;
    analyzed++;
    const recommendation = await analyzeResource(
      { arn: resource.arn, resourceType: resource.resourceType! },
      desiredState,
      tools,
    );
    if (recommendation) allRecommendations.push(recommendation);

    const done = i + 1;
    const nowMs = Date.now();
    if (
      done % progressStep === 0 ||
      nowMs - lastProgressMs >= PROGRESS_INTERVAL_MS
    ) {
      emitProgress(done);
    }
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
