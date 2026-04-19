/**
 * Logs::LogGroup cost optimizer — RetentionInDays recommendation.
 */
import type { StructuredTool } from "@langchain/core/tools";
import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import { fetchCwLogsStoragePrice } from "@/utils/pricing-lookup.js";
import { parseHourly, type CostOptRecommendation } from "./types.js";

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
