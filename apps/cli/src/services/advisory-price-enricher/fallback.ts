/**
 * Fallback builder for the advisory price enricher.
 *
 * Tagged `source: "fallback"` so the display layer renders `(estimated)`.
 *
 * @see Story 46.3
 */

import { formatLabelWithSource } from "@assignee/core";
import type { EnrichedPrice } from "../../constants/advisory-prices.js";
import type { AdvisoryPriceQuery } from "./types.js";

/**
 * Build the fallback `EnrichedPrice` for a given query — used when the
 * MCP fetch fails (timeout, missing tool, malformed response).
 */
export function buildFallback(query: AdvisoryPriceQuery): EnrichedPrice {
  return {
    value: query.fallbackValue,
    label: formatLabelWithSource(query.format(query.fallbackValue), "fallback"),
    source: "fallback",
  };
}
