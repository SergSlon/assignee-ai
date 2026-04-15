/**
 * Formatter for PricingEstimate → human-readable cost string.
 *
 * Zero hardcoded dollar amounts — all numeric values come from the
 * pricing estimate which is sourced from the Pricing MCP at runtime.
 *
 * @see feedback_no_hardcoded_prices
 */

import type { PricingEstimate } from "@assignee/core";

/**
 * Formats a PricingEstimate into a human-readable cost string used by
 * estimateCostForResource and its callers.
 */
export function formatEstimate(estimate: PricingEstimate): string {
  if (estimate.isFree) {
    return "$0.00 (always free)";
  }
  if (estimate.perMonth !== null) {
    return `~$${estimate.perMonth.toFixed(2)}/month`;
  }
  // Fall back to the label from the pricing strategy (may contain
  // formatted cost info such as "pay per request").
  return estimate.label;
}
