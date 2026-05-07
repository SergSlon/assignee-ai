/**
 * PricingDecomposer types — breaks composite resources into billable line items.
 * Each line item gets its own Pricing MCP query for real-time pricing.
 *
 * @see Story 23.1, Epic 23
 */

import type { McpPricingFilter } from "./types.js";
import type { PricingKind } from "./filter-constants.js";
import type { PriceTier } from "./tier-ladder.js";

/** Classification of a pricing line item. */
export type PricingLineItemKind =
  (typeof PricingKind)[keyof typeof PricingKind];

/**
 * A single billable component extracted from a resource's desiredState.
 * The decomposer produces these; the pricing engine queries MCP for each.
 */
export interface PricingLineItem {
  /** Human-readable label, e.g. "Compute", "Storage", "Public IPv4" */
  label: string;
  /** Quantity of this component (e.g., 8 for 8 GB, 1 for 1 address) */
  quantity: number;
  /** Unit of measurement (e.g., "GB", "address", "requests") */
  unit: string;
  /** AWS service code for pricing query */
  serviceCode: string;
  /** Filters for the Pricing MCP query */
  filters: McpPricingFilter[];
  /** Whether this is a fixed or usage-based cost */
  kind: PricingLineItemKind;
  /** Description shown in the breakdown (e.g., "t3.small", "8 GB gp3") */
  description: string;
  /** Price unit for display (e.g., "/hr", "/GB-mo", "/GB") */
  priceUnit: string;
  /** Scale factor for price extraction */
  scale?: number;
  /** Override timeout for this query */
  timeoutMs?: number;
}

/**
 * Result of a pricing query for a single line item.
 * Populated by the pricing engine after MCP queries.
 */
export interface PricingLineItemResult {
  lineItem: PricingLineItem;
  /** Per-unit price string from MCP (e.g., "$0.0416") or null if unavailable */
  unitPrice: string | null;
  /** Monthly cost for fixed items, null for usage-based */
  monthlyCost: number | null;
  /** Formatted display string (e.g., "$3.00/mo" or "$0.09/GB") */
  displayPrice: string;
  /**
   * Structured tier data when the MCP response returned a tiered rate
   * (e.g. S3 data-transfer-out: free 100 GB, $0.09/GB next 10 TB, ...).
   * Omitted (undefined) for flat-rate line items.
   * Included verbatim in the --json envelope under the "tiers" field.
   */
  tiers?: PriceTier[];
}

/**
 * Complete pricing breakdown for a resource.
 */
export interface PricingBreakdown {
  /** Fixed monthly costs (compute, storage, etc.) */
  fixedItems: PricingLineItemResult[];
  /** Usage-based per-unit rates (data transfer, requests, etc.) */
  usageBasedItems: PricingLineItemResult[];
  /** Sum of fixed monthly costs */
  fixedSubtotal: number;
  /** Timestamp when prices were fetched */
  fetchedAt: string;
  /**
   * Whether any line item pricing genuinely failed (MCP error, timeout,
   * region not supported, etc.). Does NOT include items that rendered as
   * a tiered ladder — those are successfully resolved even though they
   * don't have a single flat rate.
   */
  hasPartialFailure: boolean;
  /**
   * Story 46.2: provenance signal for callers that summarize the breakdown
   * into a single headline cost. `true` if at least one line item came
   * from `getCachedPrice()`, in which case the headline source should be
   * `"cached"` rather than `"mcp"`. `false` when every priced item came
   * from a fresh MCP fetch.
   */
  hasCacheHits: boolean;
}

/**
 * Decomposes a resource type + desiredState into billable line items.
 * Each resource type implements this to provide granular pricing.
 */
export interface PricingDecomposer {
  /** Resource type this decomposer handles (e.g., RESOURCE_TYPES.EC2_INSTANCE) */
  resourceType: string;
  /** Extract billable components from the desired state */
  decompose(desiredState: Record<string, unknown>): PricingLineItem[];
}
