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
import { PricingField } from "./filter-constants.js";

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
  if (!item.product) return false; // No product metadata — cannot validate
  const product = item.product;
  for (const filter of filters) {
    const field = filter.Field;
    const expected = filter.Value;
    // Check productFamily directly (top-level, always present in MCP responses)
    if (field === PricingField.PRODUCT_FAMILY) {
      if (!product.productFamily || product.productFamily !== expected) {
        return false;
      }
      continue;
    }
    // Check in attributes — only reject if the key IS present but has wrong value.
    // Missing attributes or missing key = cannot validate, let it pass.
    // This handles MCP responses that include productFamily but sparse attributes.
    if (product.attributes) {
      const attrKey = Object.keys(product.attributes).find(
        (k) => k.toLowerCase() === field.toLowerCase(),
      );
      if (attrKey && product.attributes[attrKey] !== expected) {
        return false;
      }
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

  // When expectedFilters are provided, prefer items that match.
  // Fallback: if only 1 item returned AND it has no product metadata (can't validate),
  // trust it — the MCP already filtered server-side.
  // If the single item HAS metadata that doesn't match, reject it.
  const filtered = expectedFilters
    ? items.filter((item) => itemMatchesFilters(item, expectedFilters))
    : items;
  const singleItemNoMetadata =
    expectedFilters &&
    filtered.length === 0 &&
    items.length === 1 &&
    !items[0]?.product;
  const passes = singleItemNoMetadata
    ? [items] // Single-item, no metadata: MCP filtered server-side, trust it
    : [filtered];

  for (const candidates of passes) {
    for (const item of candidates) {
      const onDemandTerms = Object.values(item.terms?.OnDemand ?? {});
      for (const term of onDemandTerms) {
        const dims = Object.values(term.priceDimensions ?? {});
        // Find the lowest-tier price. Accept beginRange "0" or "1" (some services
        // like AWSDataTransfer start at "1" because the first unit is free tier).
        // Reject high-tier-only responses (beginRange > 100) to avoid showing
        // volume discount rates as the base price.
        const sorted = [...dims].sort(
          (a, b) =>
            parseFloat(a.beginRange ?? "0") - parseFloat(b.beginRange ?? "0"),
        );
        const lowestDim = sorted[0];
        if (lowestDim && parseFloat(lowestDim.beginRange ?? "0") <= 100) {
          const usd = parseFloat(lowestDim.pricePerUnit?.USD ?? "0");
          if (usd > 0) {
            const scaled = usd * scale;
            const decimals =
              scaled >= 0.0001 ? 4 : Math.ceil(-Math.log10(scaled)) + 3;
            return `$${scaled.toFixed(decimals)}${unit}`;
          }
        }
      }
    }
    // If filtered pass found nothing, return null rather than a wrong price
  }
  return null;
}
