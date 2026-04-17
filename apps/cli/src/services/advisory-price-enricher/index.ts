/**
 * Public barrel for the advisory price enricher — thin re-export shim.
 *
 * Canonical implementation lives in `@assignee/core` (lifted in Story
 * 50-4 Wave 5 Pass G so the in-core advice-generator node can use the
 * enricher without reaching back into the CLI app).
 *
 * @see Story 46.3
 */
export { ENRICHABLE_PRICE_IDS, enrichAdvisoryPrices } from "@assignee/core";
