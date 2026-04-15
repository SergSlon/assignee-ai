/**
 * Re-export barrel for the advisory price enricher.
 *
 * Split into `./advisory-price-enricher/` during Wave 6e F3 to enforce
 * the 300-LOC/file rule. feedback_no_hardcoded_prices.md — registry
 * additions must route through the Pricing MCP server, never bake new
 * dollar amounts into this tree.
 *
 * @see ./advisory-price-enricher/index.ts
 * @see Story 46.3 — Advisory price enrichment at runtime
 */

export {
  enrichAdvisoryPrices,
  ENRICHABLE_PRICE_IDS,
} from "./advisory-price-enricher/index.js";
