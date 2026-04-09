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
  fetchLambdaArchPrices,
  fetchCwLogsStoragePrice,
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

/**
 * Analyze a Logs::LogGroup desiredState. Recommends setting
 * RetentionInDays when it is absent (CloudWatch Logs defaults to
 * "Never expire" when unset, so log data accumulates forever and
 * the storage bill grows linearly). The recommendation is typed
 * and projects savings against a 100 GB/month reference storage
 * footprint, using the live CW Logs Standard storage rate fetched
 * from the Pricing MCP.
 *
 * Savings model: retention caps storage at
 * (ingest_rate × retention_days). Assuming a steady-state 100 GB
 * reference baseline with indefinite retention, dropping to 30
 * days eliminates ~91% of stored bytes (everything older than 30
 * days). Savings = current_storage × 0.91 × rate.
 *
 * The percent delta is the load-bearing signal; the absolute
 * dollar amount scales linearly with actual ingest volume.
 *
 * @see (f) 2026-04-09 Task 8 — Epic 32 CW Logs retention slice
 */
export async function analyzeLogsLogGroup(
  resourceArn: string,
  desiredState: Record<string, unknown>,
  tools: StructuredTool[],
): Promise<CostOptRecommendation | null> {
  // RetentionInDays is a number-typed field on AWS::Logs::LogGroup;
  // absent or null means "Never expire" (the default). Any
  // explicit positive value means the user already set retention.
  const retention = desiredState[CfnKey.RETENTION_IN_DAYS];
  if (typeof retention === "number" && retention > 0) {
    return null;
  }

  const rate = await fetchCwLogsStoragePrice(tools);
  if (!rate) return null;

  // Parse the per-GB-month rate out of the stamped "$0.03/hr" shape
  // (extractPrice always stamps /hr — we reinterpret as GB-month).
  const ratePerGbMonth = parseHourly(rate);
  if (ratePerGbMonth === null) return null;

  // Reference workload: 100 GB of accumulated logs with no
  // retention. Dropping to 30-day retention eliminates ~91% of
  // stored bytes on a steady-state ingest pattern. The percent
  // delta is the real signal; the dollar amount is informational
  // and scales linearly with actual volume.
  const CANONICAL_REFERENCE_GB = 100;
  const RETENTION_REDUCTION_FRACTION = 0.91;
  const monthlyCurrent = CANONICAL_REFERENCE_GB * ratePerGbMonth;
  const monthlySaved = monthlyCurrent * RETENTION_REDUCTION_FRACTION;
  if (monthlySaved < 0.01) return null;
  const savingsPercent = Math.round((monthlySaved / monthlyCurrent) * 100);

  return {
    resourceArn,
    resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
    currentConfig: "RetentionInDays=<unset> (never expire)",
    recommendedConfig: "RetentionInDays=30",
    // The stamped rate goes in both slots — there's no pre/post
    // tier swap, just a retention-cap reduction on the same rate.
    currentHourly: rate,
    recommendedHourly: rate,
    // The trailing asterisk flags the 100GB reference assumption.
    monthlySavings: `$${monthlySaved.toFixed(2)}/mo*`,
    savingsPercent,
    savingsAbsoluteUsd: monthlySaved,
    rationale:
      "CloudWatch Logs defaults to 'never expire' — stored bytes grow linearly forever until you set RetentionInDays. A 30-day retention covers most debugging needs and eliminates ~91% of storage on a steady-state ingest. Dollar figure is against a 100 GB/month reference workload; savings scale linearly with actual ingest volume.",
    confidence: "high",
  };
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
    case RESOURCE_TYPES.LAMBDA_FUNCTION:
      return analyzeLambdaFunction(resource.arn, desiredState, tools);
    case RESOURCE_TYPES.LOGS_LOG_GROUP:
      return analyzeLogsLogGroup(resource.arn, desiredState, tools);
    default:
      return null;
  }
}
