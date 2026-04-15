/**
 * Billing data service — fetches live cost data from the AWS Cost Management
 * MCP server with graceful fallback to provision-log memory.
 *
 * This file is a thin barrel; implementation lives in `billing/`.
 * Decomposed in Wave-6c (per-module ≤300 LOC, SOLID OCP boundary).
 *
 * Graceful degradation chain:
 *   1. Billing MCP (live) — cost-explorer tool (getCostAndUsage / SERVICE grouping)
 *   2. Provision log memory (historical estimates)
 *   3. Empty map (cost shows "N/A")
 *
 * Zero bare catches (Wave 4 F3 + Wave 5 F2) — every error path routes through
 * `logBillingMcpFailure`. Zero hardcoded dollar amounts.
 *
 * @see Story 19.7 (cost data), Story 45.3 (recommendations), Story 46.2 (provenance).
 */

export type {
  BillingCostData,
  CostAnomaly,
  CostOptimizationRecommendation,
  ComputeOptimizerRecommendation,
} from "./billing/types.js";

export { arnToServiceSlug } from "./billing/arn-service-map.js";
export { extractResultsByTime, extractPreviewData } from "./billing/parser.js";
export { fetchBillingData, getCostSavingsEstimate } from "./billing/fetch.js";
export {
  queryCostAnomalies,
  queryCostOptimization,
  queryComputeOptimizer,
} from "./billing/recommendations.js";
