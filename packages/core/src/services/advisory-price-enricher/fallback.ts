/**
 * Fallback builder for the advisory price enricher.
 *
 * Tagged `source: "fallback"` so the display layer renders `(estimated)`.
 *
 * Lifted from apps/cli/src/services/advisory-price-enricher/fallback.ts
 * in Story 50-4 Wave 5 Pass G.
 *
 * @see Story 46.3
 */

import { formatLabelWithSource } from "../../pricing/index.js";
import type { EnrichedPrice } from "../../pricing/advisory-prices.js";
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
