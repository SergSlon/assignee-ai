/**
 * cost-optimizer.ts — A7 sprint slice (2026-04-08).
 *
 * Analyzes a managed resource's desiredState against live Pricing MCP
 * data and emits structured rightsizing recommendations. Unlike the
 * existing `cost-advisor.ts` (which returns free-form string hints
 * during plan generation), this module returns typed
 * `CostOptRecommendation` objects suitable for the `assignee optimize`
 * CLI table + the `--json` output.
 *
 * Scope for A7 (the CLI-only slice):
 *   - EC2::Instance → ARM (Graviton) swap recommendations where an
 *     ARM equivalent family exists (t3 → t4g, m5 → m6g, c5 → c6g).
 *   - RDS::DBInstance → Graviton swap where an equivalent exists
 *     (db.r5 → db.r6g, db.m5 → db.m6g).
 *   - Other resource types return no recommendation — they need
 *     either runtime usage metrics (out of scope) or structural
 *     configuration changes the user must decide interactively.
 *
 * Out of scope (deferred follow-ups):
 *   - Runtime CPU/memory usage analysis — requires CloudWatch
 *     Metrics API, which assignee.ai intentionally does not consume
 *     at plan-time.
 *   - Reserved / Savings Plans commitment recommendations — needs
 *     long-term usage telemetry (a SaaS concern).
 *   - Idle-resource detection (e.g. load balancer with zero traffic)
 *     — same CloudWatch gap as above.
 *
 * Real pricing only — zero hardcoded dollar amounts. When the
 * Pricing MCP server is unavailable, `analyzeResource()` returns
 * `null` for that resource and the caller displays a "no
 * recommendation" row.
 */

import type { StructuredTool } from "@langchain/core/tools";
import { CfnKey, RESOURCE_TYPES } from "@assignee/core";
import {
  fetchEc2InstancePrices,
  fetchRdsInstancePrices,
} from "../../utils/pricing-lookup.js";
import { ARM_EQUIVALENTS } from "./constants.js";

/** ~730 hours in an average calendar month — AWS monthly billing convention. */
const HOURS_PER_MONTH = 730;

/** Confidence tier for a recommendation. */
export type OptimizationConfidence = "high" | "medium" | "low";

/** Structured rightsizing recommendation for a single managed resource. */
export interface CostOptRecommendation {
  /** Full AWS ARN of the managed resource. */
  resourceArn: string;
  /** CloudFormation-style resource type (AWS::EC2::Instance, etc.). */
  resourceType: string;
  /** Human-readable current configuration (e.g. "t3.large"). */
  currentConfig: string;
  /** Human-readable recommended configuration. */
  recommendedConfig: string;
  /** Current on-demand hourly rate as returned by the Pricing MCP (e.g. "$0.0832/hr"). */
  currentHourly: string;
  /** Recommended on-demand hourly rate. */
  recommendedHourly: string;
  /** Estimated monthly savings delta formatted for display (e.g. "$30.37/mo"). */
  monthlySavings: string;
  /** Savings as a percentage of the current monthly cost (e.g. 20 for 20%). */
  savingsPercent: number;
  /** Raw numeric delta, for sorting highest-first. */
  savingsAbsoluteUsd: number;
  /** Short rationale for display under the recommendation. */
  rationale: string;
  /** How confident the recommendation is — high for direct swaps, lower for heuristics. */
  confidence: OptimizationConfidence;
}

/**
 * Parse a pricing-MCP response string like `"$0.0832/hr"` into a
 * numeric USD-per-hour value. Returns `null` when the input does
 * not look like a price string — callers treat that as "no price
 * data available" and skip the recommendation.
 */
function parseHourly(price: string | undefined): number | null {
  if (typeof price !== "string") return null;
  const match = price.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Derive the ARM-equivalent instance type for a given EC2 instance
 * type. Returns `null` when the input type is not in the ARM
 * equivalence map (e.g. already ARM, or a family without a Graviton
 * counterpart).
 */
function armEquivalentEc2(instanceType: string): string | null {
  for (const [x86Prefix, armPrefix] of Object.entries(ARM_EQUIVALENTS)) {
    if (instanceType.startsWith(x86Prefix)) {
      return instanceType.replace(x86Prefix, armPrefix);
    }
  }
  return null;
}

/**
 * Derive the Graviton-equivalent RDS instance class (e.g.
 * `db.r5.large` → `db.r6g.large`). Returns `null` when no known
 * mapping applies.
 */
function gravitonEquivalentRds(instanceClass: string): string | null {
  // Static mapping — matches the existing RDS_LARGE_CLASS_PREFIXES
  // in advice/constants.ts. Kept inline here because A7 is the
  // first consumer of an RDS-specific Graviton mapping.
  const rdsArmEquivalents: Record<string, string> = {
    "db.t3.": "db.t4g.",
    "db.m5.": "db.m6g.",
    "db.m6i.": "db.m6g.",
    "db.r5.": "db.r6g.",
    "db.r6i.": "db.r6g.",
    "db.c5.": "db.c6g.",
  };
  for (const [x86Prefix, armPrefix] of Object.entries(rdsArmEquivalents)) {
    if (instanceClass.startsWith(x86Prefix)) {
      return instanceClass.replace(x86Prefix, armPrefix);
    }
  }
  return null;
}

/**
 * Build a recommendation from a live price pair. Returns `null`
 * when either price is missing, the recommended price is not
 * strictly cheaper, or the resulting savings round to zero.
 *
 * Exported for unit testing.
 */
export function buildRecommendation(params: {
  resourceArn: string;
  resourceType: string;
  currentConfig: string;
  recommendedConfig: string;
  currentHourlyRaw: string;
  recommendedHourlyRaw: string;
  rationale: string;
  confidence: OptimizationConfidence;
}): CostOptRecommendation | null {
  const currentRate = parseHourly(params.currentHourlyRaw);
  const recommendedRate = parseHourly(params.recommendedHourlyRaw);
  if (currentRate === null || recommendedRate === null) return null;
  if (recommendedRate >= currentRate) return null;

  const monthlyCurrent = currentRate * HOURS_PER_MONTH;
  const monthlyRecommended = recommendedRate * HOURS_PER_MONTH;
  const delta = monthlyCurrent - monthlyRecommended;
  if (delta < 0.01) return null; // Sub-cent savings aren't worth surfacing.

  const savingsPercent = Math.round((delta / monthlyCurrent) * 100);
  const monthlySavings = `$${delta.toFixed(2)}/mo`;

  return {
    resourceArn: params.resourceArn,
    resourceType: params.resourceType,
    currentConfig: params.currentConfig,
    recommendedConfig: params.recommendedConfig,
    currentHourly: params.currentHourlyRaw,
    recommendedHourly: params.recommendedHourlyRaw,
    monthlySavings,
    savingsPercent,
    savingsAbsoluteUsd: delta,
    rationale: params.rationale,
    confidence: params.confidence,
  };
}

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
    default:
      return null;
  }
}
