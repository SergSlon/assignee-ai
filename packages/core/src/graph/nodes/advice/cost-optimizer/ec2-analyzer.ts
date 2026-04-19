/**
 * EC2::Instance cost optimizer — ARM (Graviton) swap recommendations.
 */
import type { StructuredTool } from "@langchain/core/tools";
import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import { fetchEc2InstancePrices } from "@/utils/pricing-lookup.js";
import { armEquivalentEc2 } from "./arm-equivalents.js";
import { buildRecommendation, type CostOptRecommendation } from "./types.js";

/**
 * Analyze an EC2::Instance desiredState. Queries the Pricing MCP
 * for the current instance type and its ARM equivalent in parallel,
 * returns a recommendation when the swap is cheaper.
 */
export async function analyzeEc2Instance(
  resourceArn: string,
  desiredState: Record<string, unknown>,
  tools: StructuredTool[],
): Promise<CostOptRecommendation | null> {
  const instanceType = desiredState[CfnKey.INSTANCE_TYPE];
  if (typeof instanceType !== "string" || instanceType.length === 0) {
    return null;
  }
  const armEq = armEquivalentEc2(instanceType);
  if (!armEq) return null;

  const prices = await fetchEc2InstancePrices(tools, [instanceType, armEq]);
  const current = prices[instanceType];
  const recommended = prices[armEq];
  if (!current || !recommended) return null;

  return buildRecommendation({
    resourceArn,
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    currentConfig: instanceType,
    recommendedConfig: armEq,
    currentHourlyRaw: current,
    recommendedHourlyRaw: recommended,
    rationale:
      "Migrate to the AWS Graviton (ARM) equivalent — same vCPU and memory, ~20% cheaper on-demand, same AZ.",
    confidence: "high",
  });
}
