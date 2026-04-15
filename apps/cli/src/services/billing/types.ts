/**
 * Billing data shapes — public types shared by all billing modules.
 *
 * Extracted from billing.ts during Wave-6c decomposition.
 *
 * @see Story 19.7 (cost data)
 * @see Story 45.3 (new billing tool types)
 * @see Story 46.2 (provenance tagging)
 */

import type { DataSource } from "@assignee/core";

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
