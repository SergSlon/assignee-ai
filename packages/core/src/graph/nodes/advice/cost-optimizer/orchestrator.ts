/**
 * cost-optimizer — dispatcher entry point.
 *
 * Analyzes a managed resource's desiredState against live Pricing MCP
 * data and emits structured rightsizing recommendations. Unlike the
 * existing `cost-advisor` (which returns free-form string hints during
 * plan generation), this module returns typed `CostOptRecommendation`
 * objects suitable for the `assignee optimize` CLI table + the
 * `--json` output.
 *
 * Scope (A7 sprint slice, 2026-04-08):
 *   - EC2::Instance → ARM (Graviton) swap recommendations
 *   - RDS::DBInstance → Graviton swap
 *   - Lambda::Function → arm64 architecture migration
 *   - Logs::LogGroup → RetentionInDays recommendation
 *
 * Out of scope: runtime metrics, RI/SP commitments, idle-resource
 * detection (see per-analyzer module docs for deferred follow-ups).
 *
 * Real pricing only — zero hardcoded dollar amounts. When the
 * Pricing MCP server is unavailable, `analyzeResource()` returns
 * `null` for that resource and the caller displays a "no
 * recommendation" row.
 */
import type { StructuredTool } from "@langchain/core/tools";
import { RESOURCE_TYPES } from "../../../../index.js";
import { analyzeEc2Instance } from "./ec2-analyzer.js";
import { analyzeRdsInstance } from "./rds-analyzer.js";
import { analyzeLambdaFunction } from "./lambda-analyzer.js";
import { analyzeLogsLogGroup } from "./logs-analyzer.js";
import type { CostOptRecommendation } from "./types.js";

/**
 * Dispatch one managed resource to the correct type-specific
 * analyzer. Returns `null` for resource types without a
 * rightsizing recommendation today (graceful degradation).
 */
export async function analyzeResource(
  resource: { arn: string; resourceType: string },
  desiredState: Record<string, unknown>,
  tools: StructuredTool[],
): Promise<CostOptRecommendation | null> {
  switch (resource.resourceType) {
    case RESOURCE_TYPES.EC2_INSTANCE:
      return analyzeEc2Instance(resource.arn, desiredState, tools);
    case RESOURCE_TYPES.RDS_DB_INSTANCE:
      return analyzeRdsInstance(resource.arn, desiredState, tools);
    case RESOURCE_TYPES.LAMBDA_FUNCTION:
      return analyzeLambdaFunction(resource.arn, desiredState, tools);
    case RESOURCE_TYPES.LOGS_LOG_GROUP:
      return analyzeLogsLogGroup(resource.arn, desiredState, tools);
    default:
      return null;
  }
}
