/**
 * Core type definitions for the PricingStrategy system.
 * Strategies are pure data — no I/O, no LangChain dependencies.
 */

/** A single price dimension within an on-demand pricing term. */
export interface AwsPriceDimension {
  beginRange?: string;
  pricePerUnit?: { USD?: string };
}

/** A single on-demand pricing term containing one or more price dimensions. */
export interface AwsPricingTerm {
  priceDimensions?: Record<string, AwsPriceDimension>;
}

/** A single item from the AWS Pricing API response. */
export interface AwsPricingItem {
  product?: {
    productFamily?: string;
    attributes?: Record<string, string>;
  };
  terms?: {
    OnDemand?: Record<string, AwsPricingTerm>;
  };
}

/** Top-level shape returned by the `get_pricing` MCP server tool. */
export interface AwsPricingResponse {
  data?: AwsPricingItem[];
}

export interface McpPricingFilter {
  Field: string;
  Value: string;
  Type: "TERM_MATCH";
}

/**
 * Configuration for an AWS Pricing API query via the MCP pricing server.
 * Returned by PricingStrategy.mcpConfig() when live pricing is available.
 */
export interface McpPricingConfig {
  serviceCode: string;
  filters: McpPricingFilter[];
  /** Human-readable unit label appended to the price, e.g. "/GB-month" */
  unit: string;
  /** Multiply raw API price before display (e.g. 1_000_000 for /million GB-sec) */
  scale?: number;
  /** Override default 3s timeout for resource types with larger SKU catalogs */
  timeoutMs?: number;
}

/**
 * Structured cost estimate returned by a PricingStrategy.
 * `label` is the human-readable display string used directly in the plan box.
 */
export interface PricingEstimate {
  perMonth: number | null;
  label: string;
  isFree?: boolean;
}

/**
 * Pluggable pricing strategy for a specific resource type.
 * - `estimateLocal`: pure local computation; called when MCP unavailable (offline fallback).
 * - `mcpConfig`: optional; if present, preflight-guard executes the MCP query and calls
 *   `extractFirstTierPrice` on the result. Strategies that have live pricing return a config here.
 */
export interface PricingStrategy {
  estimateLocal(desiredState?: Record<string, unknown>): PricingEstimate;
  mcpConfig?(desiredState?: Record<string, unknown>): McpPricingConfig | null;
}
