/**
 * Billing MCP recommendation queries — cost-anomaly, cost-optimization,
 * and compute-optimizer tools.
 *
 * All catches route through logBillingMcpFailure (zero bare catches).
 *
 * Extracted from billing.ts during Wave-6c decomposition.
 *
 * @see Story 45.3
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../../constants/tools.js";
import { logBillingMcpFailure } from "./error-handler.js";
import { extractPreviewData } from "./parser.js";
import type {
  CostAnomaly,
  CostOptimizationRecommendation,
  ComputeOptimizerRecommendation,
} from "./types.js";

/**
 * Queries the Billing MCP cost-anomaly tool for unusual spending patterns.
 * Returns anomalies from the last 30 days.
 */
export async function queryCostAnomalies(
  mcpTools: StructuredTool[],
): Promise<CostAnomaly[]> {
  const tool = mcpTools.find((t) => t.name === ToolName.COST_ANOMALY);
  if (!tool) return [];

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const response = await tool.invoke({
      start_date: thirtyDaysAgo.toISOString().slice(0, 10),
      end_date: now.toISOString().slice(0, 10),
    });

    const preview = extractPreviewData(response);
    const anomaliesStr = preview["Anomalies"] ?? preview["anomalies"];
    if (!anomaliesStr) return [];

    const parsed = JSON.parse(anomaliesStr);
    if (!Array.isArray(parsed)) return [];

    return parsed.map(
      (a: Record<string, unknown>) =>
        ({
          anomalyId: String(a["AnomalyId"] ?? a["anomalyId"] ?? ""),
          service: String(
            a["DimensionValue"] ?? a["service"] ?? "Unknown Service",
          ),
          impact: String(
            a["MaxImpact"] ?? a["impact"] ?? a["TotalImpact"] ?? "Unknown",
          ),
          startDate: String(a["AnomalyStartDate"] ?? a["startDate"] ?? ""),
          endDate: String(a["AnomalyEndDate"] ?? a["endDate"] ?? ""),
          severity: String(a["Severity"] ?? a["severity"] ?? "MEDIUM"),
          source: "mcp",
        }) as CostAnomaly,
    );
  } catch (err) {
    logBillingMcpFailure("queryCostAnomalies", err);
    return [];
  }
}

/**
 * Queries the Billing MCP cost-optimization tool for savings recommendations.
 * Returns cross-service optimization opportunities.
 */
export async function queryCostOptimization(
  mcpTools: StructuredTool[],
): Promise<CostOptimizationRecommendation[]> {
  const tool = mcpTools.find((t) => t.name === ToolName.COST_OPTIMIZATION);
  if (!tool) return [];

  try {
    const response = await tool.invoke({});

    const preview = extractPreviewData(response);
    const recsStr = preview["Recommendations"] ?? preview["recommendations"];
    if (!recsStr) return [];

    const parsed = JSON.parse(recsStr);
    if (!Array.isArray(parsed)) return [];

    return parsed.map(
      (r: Record<string, unknown>) =>
        ({
          id: String(r["RecommendationId"] ?? r["id"] ?? ""),
          resourceArn: String(r["ResourceArn"] ?? r["resourceArn"] ?? ""),
          resourceType: String(r["ResourceType"] ?? r["resourceType"] ?? ""),
          finding: String(
            r["Finding"] ?? r["finding"] ?? r["Description"] ?? "",
          ),
          estimatedSavings: String(
            r["EstimatedMonthlySavings"] ?? r["estimatedSavings"] ?? "N/A",
          ),
          currency: String(r["Currency"] ?? r["currency"] ?? "USD"),
          source: "mcp",
        }) as CostOptimizationRecommendation,
    );
  } catch (err) {
    logBillingMcpFailure("queryCostOptimization", err);
    return [];
  }
}

/**
 * Queries the Billing MCP compute-optimizer tool for rightsizing recommendations.
 * Returns utilization-based recommendations for EC2, Lambda, RDS, ECS.
 */
export async function queryComputeOptimizer(
  mcpTools: StructuredTool[],
): Promise<ComputeOptimizerRecommendation[]> {
  const tool = mcpTools.find((t) => t.name === ToolName.COMPUTE_OPTIMIZER);
  if (!tool) return [];

  try {
    const response = await tool.invoke({});

    const preview = extractPreviewData(response);
    const recsStr = preview["Recommendations"] ?? preview["recommendations"];
    if (!recsStr) return [];

    const parsed = JSON.parse(recsStr);
    if (!Array.isArray(parsed)) return [];

    return parsed.map(
      (r: Record<string, unknown>) =>
        ({
          resourceArn: String(r["ResourceArn"] ?? r["resourceArn"] ?? ""),
          resourceType: String(r["ResourceType"] ?? r["resourceType"] ?? ""),
          finding: String(r["Finding"] ?? r["finding"] ?? ""),
          currentConfig: String(
            r["CurrentInstanceType"] ??
              r["currentConfig"] ??
              r["CurrentConfiguration"] ??
              "",
          ),
          recommendedConfig: String(
            r["RecommendedInstanceType"] ??
              r["recommendedConfig"] ??
              r["RecommendedConfiguration"] ??
              "",
          ),
          estimatedSavings: String(
            r["EstimatedMonthlySavings"] ?? r["estimatedSavings"] ?? "N/A",
          ),
          source: "mcp",
        }) as ComputeOptimizerRecommendation,
    );
  } catch (err) {
    logBillingMcpFailure("queryComputeOptimizer", err);
    return [];
  }
}
