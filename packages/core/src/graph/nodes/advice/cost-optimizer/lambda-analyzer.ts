/**
 * Lambda::Function cost optimizer — arm64 architecture migration.
 */
import type { StructuredTool } from "@langchain/core/tools";
import { CfnKey, RESOURCE_TYPES } from "../../../../index.js";
import { fetchLambdaArchPrices } from "../../../../utils/pricing-lookup.js";
import { parseHourly, type CostOptRecommendation } from "./types.js";

/**
 * Analyze a Lambda::Function desiredState. Recommends an arm64
 * Architecture migration when the function is currently on x86_64
 * (the CCAPI default). Queries the Pricing MCP for both
 * Lambda-GB-Second (x86) and Lambda-GB-Second-ARM rates in a single
 * parallel round-trip, then projects monthly savings against a
 * conservative-but-realistic 10M GB-second reference workload. The
 * actual savings depend on invocation volume, but the *percentage*
 * delta is workload-independent and is the load-bearing signal the
 * operator should see.
 */
export async function analyzeLambdaFunction(
  resourceArn: string,
  desiredState: Record<string, unknown>,
  tools: StructuredTool[],
): Promise<CostOptRecommendation | null> {
  // CCAPI default Architectures is ["x86_64"]; only recommend a
  // migration when the current function is NOT already arm64.
  const architectures = desiredState[CfnKey.ARCHITECTURES];
  const isAlreadyArm =
    Array.isArray(architectures) && architectures.some((a) => a === "arm64");
  if (isAlreadyArm) return null;

  const prices = await fetchLambdaArchPrices(tools);
  if (!prices.x86 || !prices.arm) return null;

  // Parse the GB-second rates out of the stamped strings. We reuse
  // the hourly parser because the MCP response shape is identical —
  // the only difference is units.
  const x86Rate = parseHourly(prices.x86);
  const armRate = parseHourly(prices.arm);
  if (x86Rate === null || armRate === null) return null;
  if (armRate >= x86Rate) return null;

  // Project savings against a canonical 10M GB-second/month
  // reference workload. The percent delta is the real signal
  // (AWS publishes a flat ~20% arm discount on Lambda Duration);
  // the absolute dollar amount is informational and scales
  // linearly with volume.
  const CANONICAL_GB_SECONDS_PER_MONTH = 10_000_000;
  const monthlyCurrent = x86Rate * CANONICAL_GB_SECONDS_PER_MONTH;
  const monthlyRecommended = armRate * CANONICAL_GB_SECONDS_PER_MONTH;
  const delta = monthlyCurrent - monthlyRecommended;
  if (delta < 0.01) return null;
  const savingsPercent = Math.round((delta / monthlyCurrent) * 100);

  return {
    resourceArn,
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    currentConfig: "x86_64",
    recommendedConfig: "arm64",
    currentHourly: prices.x86,
    recommendedHourly: prices.arm,
    // The trailing asterisk flags that the dollar amount is a
    // reference projection, not an exact measurement — the rationale
    // string below spells out the 10M GB-s/month assumption.
    monthlySavings: `$${delta.toFixed(2)}/mo*`,
    savingsPercent,
    savingsAbsoluteUsd: delta,
    rationale:
      "Migrate to arm64 (Graviton). Same code path via Lambda-managed AL2023, ~20% cheaper per GB-second. Savings scale linearly with invocation volume — figure is against a 10M GB-s/month reference workload.",
    confidence: "medium",
  };
}
