/**
 * Parses the `get_pricing` MCP server response to extract the first-tier (beginRange=0) price.
 * Returns a formatted price string like "$0.0230/GB-month", or null if no price found.
 *
 * @param data   - Parsed JSON response object from the MCP pricing tool
 * @param unit   - Human-readable unit label appended to the price, e.g. "/GB-month"
 * @param scale  - Optional multiplier applied to the raw price (default 1)
 */
export function extractFirstTierPrice(
  data: Record<string, unknown>,
  unit: string,
  scale = 1,
): string | null {
  const items = (data["data"] as unknown[]) ?? [];
  for (const item of items) {
    const onDemand = (item as Record<string, unknown>)?.["terms"] as
      | Record<string, unknown>
      | undefined;
    const terms = Object.values(
      (onDemand?.["OnDemand"] as Record<string, unknown>) ?? {},
    );
    for (const term of terms) {
      const dims = Object.values(
        ((term as Record<string, unknown>)?.["priceDimensions"] as Record<
          string,
          unknown
        >) ?? {},
      );
      for (const dim of dims) {
        const d = dim as Record<string, unknown>;
        if (d["beginRange"] === "0") {
          const usd = parseFloat(
            (d["pricePerUnit"] as Record<string, string>)?.["USD"] ?? "0",
          );
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
