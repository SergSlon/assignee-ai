/**
 * Parses the `get_pricing` MCP server response to extract the first-tier (beginRange=0) price.
 * Returns a formatted price string like "$0.0230/GB-month", or null if no price found.
 *
 * @param data   - Parsed JSON response object from the MCP pricing tool
 * @param unit   - Human-readable unit label appended to the price, e.g. "/GB-month"
 * @param scale  - Optional multiplier applied to the raw price (default 1)
 */
import type { AwsPricingResponse } from "./types.js";

export function extractFirstTierPrice(
  data: AwsPricingResponse,
  unit: string,
  scale = 1,
): string | null {
  const items = data.data ?? [];
  for (const item of items) {
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
  return null;
}
