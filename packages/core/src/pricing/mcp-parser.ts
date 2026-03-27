/**
 * Parses the `get_pricing` MCP server response to extract the first-tier (beginRange=0) price.
 * Returns a formatted price string like "$0.0230/GB-month", or null if no price found.
 *
 * When `expectedFilters` are provided, items whose `product.attributes` don't match the
 * filter values are skipped — this prevents returning a storage price when the query was
 * for API requests (common when the MCP response contains multiple product families).
 *
 * @param data   - Parsed JSON response object from the MCP pricing tool
 * @param unit   - Human-readable unit label appended to the price, e.g. "/GB-month"
 * @param scale  - Optional multiplier applied to the raw price (default 1)
 * @param expectedFilters - Optional filters to validate response items against
 */
import type { AwsPricingResponse, McpPricingFilter } from "./types.js";

/**
 * Check if a response item's product.attributes match the expected filters.
 * Only checks filters whose Field is present in attributes (case-insensitive).
 */
interface ProductInfo {
  productFamily?: string;
  attributes?: Record<string, string>;
}

function itemMatchesFilters(
  item: { product?: ProductInfo },
  filters: McpPricingFilter[],
): boolean {
  if (!item.product) return false; // No product metadata — cannot validate, skip to fallback pass
  const product = item.product;
  for (const filter of filters) {
    const field = filter.Field;
    const expected = filter.Value;
    // Check productFamily directly
    if (field === "productFamily") {
      if (!product.productFamily || product.productFamily !== expected) {
        return false;
      }
      continue;
    }
    // Check in attributes (case-insensitive key lookup)
    if (!product.attributes) return false;
    const attrKey = Object.keys(product.attributes).find(
      (k) => k.toLowerCase() === field.toLowerCase(),
    );
    if (!attrKey || product.attributes[attrKey] !== expected) {
      return false;
    }
  }
  return true;
}

export function extractFirstTierPrice(
  data: AwsPricingResponse,
  unit: string,
  scale = 1,
  expectedFilters?: McpPricingFilter[],
): string | null {
  const items = data.data ?? [];

  // When expectedFilters are provided, ONLY consider items that match.
  // Do NOT fall back to unfiltered items — returning the wrong price
  // (e.g. storage $0.023 for a PUT request query) is worse than "unavailable".
  const passes = expectedFilters
    ? [items.filter((item) => itemMatchesFilters(item, expectedFilters))]
    : [items];

  for (const candidates of passes) {
    for (const item of candidates) {
      const onDemandTerms = Object.values(item.terms?.OnDemand ?? {});
      for (const term of onDemandTerms) {
        const dims = Object.values(term.priceDimensions ?? {});
        for (const dim of dims) {
          if (dim.beginRange === "0") {
            const usd = parseFloat(dim.pricePerUnit?.USD ?? "0");
            if (usd > 0) {
              const scaled = usd * scale;
              const decimals =
                scaled >= 0.0001 ? 4 : Math.ceil(-Math.log10(scaled)) + 3;
              return `$${scaled.toFixed(decimals)}${unit}`;
            }
          }
        }
      }
    }
    // If filtered pass found nothing, return null rather than a wrong price
  }
  return null;
}
