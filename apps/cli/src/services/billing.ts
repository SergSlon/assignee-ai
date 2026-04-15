/**
 * Billing data service — fetches live cost data from the AWS Cost Management MCP server.
 *
 * Graceful degradation chain:
 *   1. Billing MCP (live) — cost-explorer tool (getCostAndUsage grouped by SERVICE)
 *   2. Provision log memory (historical estimates)
 *   3. Empty map (cost shows "N/A")
 *
 * Note: RESOURCE_ID grouping is only available via getCostAndUsageWithResources
 * (limited to last 14 days). We use SERVICE grouping for reliable monthly data
 * and distribute costs across resources of the same service.
 *
 * @see Story 19.7
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { defaultMemoryService } from "./memory.js";
import { AWS_REGION, UNKNOWN_FALLBACK } from "../config/constants.js";
import type { ManagedResource } from "./list-resources.js";
import { CostEstimateLabel, type DataSource } from "@assignee/core";
import { log, LOG_ACTIONS, LogLevel } from "../utils/logger.js";

/**
 * Wave 3 F9 P2-3b: shared helper that replaces four bare `catch {}` blocks
 * in this file. Emits a structured warn-level event so the failure surfaces
 * under --verbose / ASSIGNEE_VERBOSITY=verbose and is persisted to the
 * rotating daily log file (error/warn are always persisted).
 *
 * Kept local to billing.ts because the "billing-mcp" runId + action tuple
 * is specific to this file's graceful-degradation chain (see SECURITY-AUDIT
 * H19 — silent error drop).
 */
function logBillingMcpFailure(action: string, err: unknown): void {
  log({
    ts: new Date().toISOString(),
    runId: "billing-mcp",
    level: LogLevel.WARN,
    action: LOG_ACTIONS.BILLING_MCP_QUERY_FAILED,
    extras: {
      billingAction: action,
      error: err instanceof Error ? err.message : String(err),
    },
  });
}

export interface BillingCostData {
  arn: string;
  actualMonthlyCost: string;
  forecastedMonthlyCost: string;
  currency: string;
  lastUpdated: string;
  /**
   * Story 46.2: provenance tag.
   *  - "mcp"     → fresh from the Billing MCP cost-explorer call
   *  - "offline" → replayed from the local provision log because the
   *                Billing MCP was unreachable / returned no rows
   */
  source: DataSource;
}

/**
 * Builds a date range covering the current calendar month.
 * The Cost Explorer API requires Start (inclusive) and End (exclusive).
 */
function currentMonthRange(): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  const start = `${year}-${String(month + 1).padStart(2, "0")}-01`;

  // End is exclusive — first day of next month
  const nextMonth = month + 1;
  const endYear = nextMonth > 11 ? year + 1 : year;
  const endMonth = nextMonth > 11 ? 1 : nextMonth + 1;
  const end = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

  return { start, end };
}

/**
 * Maps an ARN to its AWS service name as used in Cost Explorer SERVICE dimension.
 * e.g. "arn:aws:s3:::my-bucket" -> "Amazon Simple Storage Service"
 *
 * This is a best-effort mapping — unknown services return undefined.
 */
const ARN_SERVICE_TO_CE_SERVICE: Record<string, string> = {
  s3: "Amazon Simple Storage Service",
  lambda: "AWS Lambda",
  ec2: "Amazon Elastic Compute Cloud - Compute",
  rds: "Amazon Relational Database Service",
  dynamodb: "Amazon DynamoDB",
  sqs: "Amazon Simple Queue Service",
  sns: "Amazon Simple Notification Service",
  ecs: "Amazon Elastic Container Service",
  elasticloadbalancing: "Amazon Elastic Load Balancing",
  cloudfront: "Amazon CloudFront",
  iam: "AWS Identity and Access Management",
  logs: "Amazon CloudWatch Logs",
  events: "Amazon EventBridge",
  secretsmanager: "AWS Secrets Manager",
  kms: "AWS Key Management Service",
};

/**
 * Extracts the AWS service slug from an ARN.
 * e.g. "arn:aws:s3:::my-bucket" -> "s3"
 *      "arn:aws:lambda:us-east-1:123:function:foo" -> "lambda"
 */
/** @internal */
export function arnToServiceSlug(arn: string): string | undefined {
  // ARN format: arn:partition:service:region:account:resource
  const match = /^arn:aws[\w-]*:([^:]+):/.exec(arn);
  if (match) return match[1];
  // S3 ARNs may have empty region/account: arn:aws:s3:::bucket
  if (/^arn:aws[\w-]*:s3:/.test(arn)) return "s3";
  return undefined;
}

/**
 * Extracts ResultsByTime from the new session-based MCP response format.
 *
 * The billing-cost-management-mcp-server@0.0.17+ returns:
 * {
 *   status: "success",
 *   data: {
 *     ...,
 *     preview: [{ key: "ResultsByTime", value: "<JSON string>" }, ...]
 *   }
 * }
 */
/** @internal */
export function extractResultsByTime(response: unknown): unknown[] {
  if (typeof response !== "object" || response === null) return [];

  // Unwrap MCP text wrapper ({ type: "text", text: "<JSON>" }) if present
  let resp = response as Record<string, unknown>;
  if ("text" in resp && typeof resp["text"] === "string") {
    try {
      resp = JSON.parse(resp["text"] as string) as Record<string, unknown>;
    } catch (err) {
      logBillingMcpFailure("extractResultsByTime.parseTextWrapper", err);
      return [];
    }
  }
  // Also handle string responses (unwrapMcpText output)
  if (typeof resp === "string") {
    try {
      resp = JSON.parse(resp) as Record<string, unknown>;
    } catch (err) {
      logBillingMcpFailure("extractResultsByTime.parseStringResponse", err);
      return [];
    }
  }

  // New session-based format: data.preview contains key-value pairs
  const data = resp["data"] as Record<string, unknown> | undefined;
  const preview = data?.["preview"];
  if (Array.isArray(preview)) {
    const rtEntry = (preview as Array<{ key: string; value: string }>).find(
      (p) => p.key === "ResultsByTime",
    );
    if (rtEntry) {
      try {
        const parsed = JSON.parse(rtEntry.value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        logBillingMcpFailure("extractResultsByTime.parseResultsByTime", err);
        return [];
      }
    }
  }

  return [];
}

/**
 * Queries the Billing MCP server's cost-explorer tool for service-level costs.
 * Groups by SERVICE dimension (RESOURCE_ID requires getCostAndUsageWithResources
 * which is limited to 14 days). Distributes service costs across resources of
 * that service type.
 *
 * Returns an array of BillingCostData entries. Returns empty array on any error.
 */
async function queryBillingMcp(
  resources: ManagedResource[],
  mcpTools: StructuredTool[],
): Promise<BillingCostData[]> {
  const costTool = mcpTools.find((t) => t.name === ToolName.COST_EXPLORER);
  if (!costTool) return [];

  const { start, end } = currentMonthRange();

  // Collect unique service names from the resource ARNs
  const serviceNames = new Set<string>();
  for (const r of resources) {
    const slug = arnToServiceSlug(r.arn);
    const ceName = slug ? ARN_SERVICE_TO_CE_SERVICE[slug] : undefined;
    if (ceName) serviceNames.add(ceName);
  }

  try {
    const response = await costTool.invoke({
      operation: "getCostAndUsage",
      start_date: start,
      end_date: end,
      granularity: "MONTHLY",
      metrics: JSON.stringify(["UnblendedCost"]),
      group_by: JSON.stringify([{ Type: "DIMENSION", Key: "SERVICE" }]),
      filter:
        serviceNames.size > 0
          ? JSON.stringify({
              Dimensions: {
                Key: "SERVICE",
                Values: [...serviceNames],
              },
            })
          : undefined,
    });

    const resultsByTime = extractResultsByTime(response);
    const results: BillingCostData[] = [];

    // Build a map of service name -> total cost from the response
    const serviceCosts = new Map<string, { amount: number; unit: string }>();
    for (const timePeriod of resultsByTime as Array<{
      Groups?: Array<{
        Keys?: string[];
        Metrics?: Record<string, { Amount?: string; Unit?: string }>;
      }>;
    }>) {
      if (timePeriod?.Groups) {
        for (const group of timePeriod.Groups) {
          const serviceName = group?.Keys?.[0];
          const ubCost = group?.Metrics?.["UnblendedCost"] as
            | { Amount?: string; Unit?: string }
            | undefined;
          const amount = ubCost?.Amount;
          const unit = ubCost?.Unit ?? "USD";
          if (serviceName && amount !== undefined) {
            const parsed = parseFloat(amount);
            if (Number.isNaN(parsed)) continue;
            const existing = serviceCosts.get(serviceName);
            const newAmount = parsed + (existing?.amount ?? 0);
            serviceCosts.set(serviceName, { amount: newAmount, unit });
          }
        }
      }
    }

    // Distribute service costs across resources of the same service
    // Group resources by their CE service name
    const resourcesByService = new Map<string, ManagedResource[]>();
    for (const r of resources) {
      const slug = arnToServiceSlug(r.arn);
      const ceName = slug ? ARN_SERVICE_TO_CE_SERVICE[slug] : undefined;
      if (ceName) {
        const list = resourcesByService.get(ceName) ?? [];
        list.push(r);
        resourcesByService.set(ceName, list);
      }
    }

    for (const [serviceName, serviceResources] of resourcesByService) {
      const cost = serviceCosts.get(serviceName);
      if (!cost) continue;

      // Split cost evenly among resources of this service type
      const perResourceCost = cost.amount / serviceResources.length;
      for (const r of serviceResources) {
        results.push({
          arn: r.arn,
          actualMonthlyCost: `$${perResourceCost.toFixed(2)}/month`,
          forecastedMonthlyCost: `$${perResourceCost.toFixed(2)}/month`,
          currency: cost.unit,
          lastUpdated: new Date().toISOString(),
          // Story 46.2: live cost-explorer response
          source: "mcp",
        });
      }
    }

    return results;
  } catch (err) {
    // Graceful degradation: billing is non-blocking — return empty on any error.
    // Surface the reason under --verbose so operators can diagnose silent N/A.
    logBillingMcpFailure("queryBillingMcp.getCostAndUsage", err);
    return [];
  }
}

/**
 * Fetches live billing data for managed resources from the Billing MCP server.
 * Falls back to provision log memory if MCP is unavailable.
 */
export async function fetchBillingData(
  resources: ManagedResource[],
  mcpTools?: StructuredTool[],
): Promise<Map<string, BillingCostData>> {
  const costMap = new Map<string, BillingCostData>();

  // Try Billing MCP server first
  if (mcpTools && mcpTools.length > 0) {
    try {
      const billingData = await queryBillingMcp(resources, mcpTools);
      for (const entry of billingData) {
        costMap.set(entry.arn, entry);
      }
      if (costMap.size > 0) return costMap;
    } catch (err) {
      // MCP unavailable — fall through to memory fallback. Log at warn so
      // operators can correlate "offline" provenance rows with the root cause.
      logBillingMcpFailure("fetchBillingData.queryBillingMcp", err);
    }
  }

  // Fallback: provision log memory
  // Story 46.2: tag every fallback row "offline" so the user can tell at a
  // glance that they're looking at log replay, not live AWS data.
  const provisions = await defaultMemoryService.readProvisions();
  for (const p of provisions) {
    if (p.resourceArn && p.estimatedMonthlyCost) {
      costMap.set(p.resourceArn, {
        arn: p.resourceArn,
        actualMonthlyCost: p.estimatedMonthlyCost,
        forecastedMonthlyCost: p.estimatedMonthlyCost,
        currency: "USD",
        lastUpdated: p.timestamp,
        source: "offline",
      });
    }
  }

  return costMap;
}

/**
 * Gets cost savings estimate for a specific resource.
 * Used by `assignee destroy` to show savings when removing a resource.
 *
 * @returns Formatted string like "$X.XX/month saved" or "N/A" on failure
 */
// ── New billing tool types (Story 45.3) ────────────────────────────────────

export interface CostAnomaly {
  anomalyId: string;
  service: string;
  impact: string;
  startDate: string;
  endDate: string;
  severity: string;
  /** Story 46.2: provenance — always "mcp" for live billing responses. */
  source: DataSource;
}

export interface CostOptimizationRecommendation {
  id: string;
  resourceArn: string;
  resourceType: string;
  finding: string;
  estimatedSavings: string;
  currency: string;
  /** Story 46.2: provenance — always "mcp" for live billing responses. */
  source: DataSource;
}

export interface ComputeOptimizerRecommendation {
  resourceArn: string;
  resourceType: string;
  finding: string;
  currentConfig: string;
  recommendedConfig: string;
  estimatedSavings: string;
  /** Story 46.2: provenance — always "mcp" for live billing responses. */
  source: DataSource;
}

/**
 * Extracts preview data from session-based Billing MCP response.
 * Handles the standard wrapper: {status:"success", data:{preview:[{key,value}]}}
 */
function extractPreviewData(response: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof response !== "object" || response === null) return result;

  let resp = response as Record<string, unknown>;
  if ("text" in resp && typeof resp["text"] === "string") {
    try {
      resp = JSON.parse(resp["text"] as string) as Record<string, unknown>;
    } catch (err) {
      logBillingMcpFailure("extractPreviewData.parseTextWrapper", err);
      return result;
    }
  }

  const data = resp["data"] as Record<string, unknown> | undefined;
  const preview = data?.["preview"];
  if (Array.isArray(preview)) {
    for (const entry of preview as Array<{ key: string; value: string }>) {
      if (entry.key && entry.value) {
        result[entry.key] = entry.value;
      }
    }
  }
  return result;
}

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

export async function getCostSavingsEstimate(
  arn: string,
  mcpTools?: StructuredTool[],
): Promise<string> {
  try {
    const dummyResource: ManagedResource = {
      resourceType: UNKNOWN_FALLBACK,
      arn,
      region: AWS_REGION,
      createdDate: CostEstimateLabel.NA,
      estimatedMonthlyCost: CostEstimateLabel.NA,
    };

    const costMap = await fetchBillingData([dummyResource], mcpTools);
    const data = costMap.get(arn);
    if (data) {
      return `${data.actualMonthlyCost} saved`;
    }
  } catch (err) {
    logBillingMcpFailure("getCostSavingsEstimate", err);
    // Graceful degradation
  }

  return CostEstimateLabel.NA;
}
