/**
 * Parses the `get_pricing` MCP server response to extract prices.
 *
 * Two public functions:
 *  - `extractFirstTierPrice`  — existing flat-rate path (single pricePerUnit string).
 *  - `extractTieredPrice`     — new tiered path: returns a TierLadderRender when the
 *                               response contains multiple priceDimensions forming a
 *                               sequential range ladder (e.g. S3 data-transfer-out).
 *
 * When `expectedFilters` are provided, items whose `product.attributes` don't match
 * the filter values are skipped — this prevents returning a storage price when the
 * query was for API requests (common when the MCP response contains multiple product
 * families).
 *
 * @param data   - Parsed JSON response object from the MCP pricing tool
 * @param unit   - Human-readable unit label appended to the price, e.g. "/GB-month"
 * @param scale  - Optional multiplier applied to the raw price (default 1)
 * @param expectedFilters - Optional filters to validate response items against
 */
import type { AwsPricingResponse, McpPricingFilter } from "./types.js";
import { PricingField } from "./filter-constants.js";
import {
  isTieredResponse,
  renderTierLadder,
  type TierLadderRender,
} from "./tier-ladder.js";

/**
 * Check if a response item's product.attributes match the expected filters.
 * Only checks filters whose Field is present in attributes (case-insensitive).
 */
interface ProductInfo {
  productFamily?: string;
  attributes?: Record<string, string>;
}

/**
 * AWS Pricing API region/class prefix on `usagetype` attributes.
 *
 * Real Pricing API responses prepend a short ALL-CAPS-DIGITS-HYPHEN
 * token (or a chain of such tokens) onto the usagetype, e.g.:
 *
 *   `USE1-TimedStorage-ByteHrs`         (us-east-1, Standard)
 *   `EU-TimedStorage-ByteHrs`           (eu-west-1, Standard)
 *   `USE1-TimedStorage-SIA-ByteHrs`     (Standard-IA)
 *   `USE1-TimedStorage-GIR-ByteHrs`     (Glacier Instant Retrieval)
 *   `USE1-TimedStorage-INT-FA-ByteHrs`  (Intelligent-Tiering Frequent)
 *
 * Decomposers store the canonical *un*prefixed value as the TERM_MATCH
 * filter (e.g. `TimedStorage-ByteHrs`), so a naive equality check
 * against the API-returned value fails for any non-default region.
 *
 * This regex strips ONE leading ALL-CAPS-DIGITS-HYPHEN token (terminated
 * by `-`) from an API value before retrying the equality check. It is
 * intentionally conservative:
 *
 *   - prefix MUST be at the start (`^`)
 *   - prefix MUST contain only `A-Z` and `0-9`
 *   - prefix MUST end with `-` (followed by at least one more char)
 *   - lowercase letters, no-hyphen values, and partial-caps values
 *     (e.g. `MyValue`, `name-foo`, `gp3`) are left untouched
 *
 * One strip is sufficient for every observed real-world case — the
 * region prefix is the only ALL-CAPS prefix on usagetype values; the
 * inner storage-class tokens (`SIA-`, `GIR-`, `INT-FA-`) become part
 * of the matched stored filter value after the strip.
 */
const PRICING_API_PREFIX_RE = /^[A-Z0-9]+-/;

/**
 * Compare a single API attribute value against a filter value.
 * Returns true on exact match, OR on match-after-stripping a single
 * ALL-CAPS-DIGITS-HYPHEN prefix (e.g. `USE1-`) from the API value.
 *
 * The prefix strip only fires when the regex matches the API value's
 * leading chars — values without such a prefix are compared
 * exact-equality only.
 *
 * @internal exported for unit tests (see `mcp-parser.test.ts`).
 */
export function attributeValueMatches(
  apiValue: string,
  expected: string,
): boolean {
  if (apiValue === expected) return true;
  if (PRICING_API_PREFIX_RE.test(apiValue)) {
    const stripped = apiValue.replace(PRICING_API_PREFIX_RE, "");
    if (stripped === expected) return true;
  }
  return false;
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
      if (
        attrKey &&
        !attributeValueMatches(product.attributes[attrKey]!, expected)
      ) {
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
          const usd = parseFloat(lowestDim.pricePerUnit?.["USD"] ?? "0");
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

/**
 * Attempt to extract a tiered-rate render from the MCP pricing response.
 *
 * Returns a `TierLadderRender` when:
 *  - At least one candidate item's OnDemand term has > 1 priceDimension, AND
 *  - The ranges are monotonically sequential (non-overlapping).
 *
 * Returns undefined when:
 *  - No matching items, OR
 *  - All matching items are flat-rate (single priceDimension), OR
 *  - Ranges are non-monotonic (data error from AWS) — caller falls back to "unavailable".
 *
 * This function mirrors `extractFirstTierPrice`'s filter/fallback logic so the
 * same MCP response is parsed consistently by both paths.
 */
export function extractTieredPrice(
  data: AwsPricingResponse,
  expectedFilters?: McpPricingFilter[],
): TierLadderRender | undefined {
  const items = data.data ?? [];

  const filtered = expectedFilters
    ? items.filter((item) => itemMatchesFilters(item, expectedFilters))
    : items;
  const singleItemNoMetadata =
    expectedFilters &&
    filtered.length === 0 &&
    items.length === 1 &&
    !items[0]?.product;
  const candidates = singleItemNoMetadata ? items : filtered;

  for (const item of candidates) {
    const onDemandTerms = Object.values(item.terms?.OnDemand ?? {});
    for (const term of onDemandTerms) {
      const dims = term.priceDimensions ?? {};
      if (isTieredResponse(dims)) {
        const rendered = renderTierLadder(dims);
        if (rendered !== undefined) {
          return rendered;
        }
        // Non-monotonic — signal failure (return undefined)
        return undefined;
      }
    }
  }

  return undefined;
}

export type { TierLadderRender };
