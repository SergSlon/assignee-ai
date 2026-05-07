/**
 * Core type definitions for the PricingStrategy system.
 * Strategies are pure data — no I/O, no LangChain dependencies.
 */

import type { PricingMatchType } from "./filter-constants.js";

/** A single price dimension within an on-demand pricing term. */
export interface AwsPriceDimension {
  beginRange?: string;
  /** End of this tier range. "Inf" or absent means no upper bound (top tier). */
  endRange?: string;
  /** Unit label for this dimension (e.g. "GB", "GB-Mo", "Hrs"). */
  unit?: string;
  /** Per-unit price by currency code. Typically { USD: "0.0900000000" }. */
  pricePerUnit?: Record<string, string>;
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
  Type: typeof PricingMatchType.TERM_MATCH;
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
 * Provenance tag for any user-facing dollar amount, security finding, or
 * pricing hint. Lets the display layer tell the user where a number came
 * from instead of presenting "$32.85/mo" identically whether it was just
 * fetched from AWS or hand-coded as an estimate.
 *
 * - `mcp`      → fetched live from a Model Context Protocol server (AWS
 *                Pricing, Cost Explorer, Well-Architected Security, etc.)
 *                during this command invocation. Authoritative.
 * - `cached`   → fetched live during an earlier command and replayed from
 *                a session/disk cache. Recent but not "right now".
 * - `fallback` → produced by a local heuristic / hand-coded constant /
 *                `estimateLocal()`. No live AWS data involved. May be stale.
 * - `offline`  → replayed from a persisted log entry (e.g. previous
 *                `assignee plan` output) when the live MCP path was
 *                unreachable. Historic.
 * - `free`     → the resource is authoritatively free of charge (IAM role,
 *                EC2 internet gateway, ECS cluster control plane, etc.).
 *                Distinct from `fallback` because we KNOW the cost is zero.
 *
 * @see Story 46.2 — DataSource tagging for all user-facing values
 */
export type DataSource = "mcp" | "cached" | "fallback" | "offline" | "free";

/** Display suffix shown after a label for each non-free source. */
const SOURCE_SUFFIX: Record<DataSource, string> = {
  mcp: " (live)",
  cached: " (cached)",
  fallback: " (estimated)",
  offline: " (from log)",
  free: "",
};

/**
 * Append the source-specific suffix to a label.
 *
 * @example
 *   formatLabelWithSource("~$32.85/mo", "mcp")      // "~$32.85/mo (live)"
 *   formatLabelWithSource("Free",       "free")     // "Free"
 *   formatLabelWithSource("~$0.5/mo",   "fallback") // "~$0.5/mo (estimated)"
 */
export function formatLabelWithSource(
  label: string,
  source: DataSource,
): string {
  return `${label}${SOURCE_SUFFIX[source]}`;
}

/**
 * Structured cost estimate returned by a PricingStrategy.
 * `label` is the human-readable display string used directly in the plan box.
 *
 * Story 46.2: every estimate MUST carry a `source` so the display layer
 * can tell the user whether the dollar amount is live MCP data, a local
 * fallback heuristic, or an authoritatively-free resource.
 */
export interface PricingEstimate {
  perMonth: number | null;
  label: string;
  isFree?: boolean;
  /**
   * Where this estimate came from. Required so the TypeScript compiler
   * forces every strategy / fetch path to declare its provenance.
   * @see DataSource
   */
  source: DataSource;
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
