/**
 * RDS::DBInstance cost optimizer — Graviton swap recommendations.
 */
import type { StructuredTool } from "@langchain/core/tools";
import { CfnKey, RESOURCE_TYPES } from "@assignee/core";
import { fetchRdsInstancePrices } from "../../../../utils/pricing-lookup.js";
import { gravitonEquivalentRds } from "./arm-equivalents.js";
import { buildRecommendation, type CostOptRecommendation } from "./types.js";

/**
 * Analyze an RDS::DBInstance desiredState. Queries the Pricing MCP
 * for the current class and its Graviton equivalent in parallel,
 * returns a recommendation when the swap is cheaper.
 */
export async function analyzeRdsInstance(
  resourceArn: string,
  desiredState: Record<string, unknown>,
  tools: StructuredTool[],
): Promise<CostOptRecommendation | null> {
  const instanceClass = desiredState[CfnKey.DB_INSTANCE_CLASS];
  if (typeof instanceClass !== "string" || instanceClass.length === 0) {
    return null;
  }
  const engine = desiredState[CfnKey.ENGINE];
  if (typeof engine !== "string" || engine.length === 0) return null;
  const gravitonEq = gravitonEquivalentRds(instanceClass);
  if (!gravitonEq) return null;

  const prices = await fetchRdsInstancePrices(
    tools,
    [instanceClass, gravitonEq],
    engine,
  );
  const current = prices[instanceClass];
  const recommended = prices[gravitonEq];
  if (!current || !recommended) return null;

  return buildRecommendation({
    resourceArn,
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    currentConfig: instanceClass,
    recommendedConfig: gravitonEq,
    currentHourlyRaw: current,
    recommendedHourlyRaw: recommended,
    rationale:
      "Migrate to the AWS Graviton (ARM) equivalent — same CPU/memory class, typically 10-20% cheaper for the same engine.",
    confidence: "medium",
  });
}
