/**
 * Tier-ladder rendering helper for AWS Pricing API tiered responses.
 *
 * When the AWS Pricing API returns multiple priceDimensions for a single
 * usage type (e.g. S3 data-transfer-out: free first 100 GB, $0.09/GB
 * next 10 TB, $0.085/GB next 40 TB, etc.), the existing flat-rate renderer
 * either picks the first tier or marks the line item "unavailable".
 *
 * This helper:
 *   1. Detects tiered responses (> 1 priceDimension that forms a sequential range).
 *   2. Renders a compact one-liner for the plan box.
 *   3. Returns a structured tiers array for the --json envelope.
 *
 * @see Story: feature-pricing-tiered-rate-display
 */

import type { AwsPriceDimension } from "./types.js";

/** A single AWS Pricing tier as returned from the Pricing API. */
export interface PriceTier {
  /** Cumulative usage at the START of this tier (e.g. 0, 100, 10240). */
  beginRange: number;
  /** Cumulative usage at the END of this tier; undefined = "Inf" (top tier). */
  endRange?: number;
  /** Per-unit rate (string to preserve precision). */
  rate: string;
  /** Currency code (USD / CNY / EUR — read from AWS response). */
  currency: string;
  /** Unit (GB, GB-mo, request, etc.). */
  unit: string;
}

/** Render output from the tier-ladder helper. */
export interface TierLadderRender {
  /** Plain-text one-liner for the plan box. */
  text: string;
  /** Structured tiers for --json mode envelope. All tiers, never truncated. */
  tiers: PriceTier[];
}

/**
 * Extended price dimension shape that includes both endRange and multi-currency.
 * The AWS Pricing API always returns these — we extend the base type locally
 * rather than broadening the shared AwsPriceDimension to avoid cascading changes.
 */
interface FullPriceDimension extends AwsPriceDimension {
  endRange?: string;
  unit?: string;
  pricePerUnit?: Record<string, string>;
}

/**
 * Detect if a priceDimensions record represents a tiered rate.
 * A tiered response has more than one dimension OR a single dimension
 * whose endRange is NOT "Inf" (meaning more tiers may follow that AWS
 * didn't include in this query). We treat > 1 dimension as tiered.
 *
 * A single dimension with beginRange=0, endRange=Inf is effectively flat
 * and is NOT flagged as tiered (caller uses the existing flat-rate path).
 */
export function isTieredResponse(
  priceDimensions: Record<string, FullPriceDimension>,
): boolean {
  const dims = Object.values(priceDimensions);
  if (dims.length <= 1) return false;
  return true;
}

/** Currency symbol lookup for common AWS billing currencies. */
function currencyPrefix(currency: string): string {
  switch (currency.toUpperCase()) {
    case "USD":
      return "$";
    case "CNY":
      return "¥";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    case "JPY":
      return "¥";
    case "AUD":
      return "A$";
    case "CAD":
      return "C$";
    default:
      return `${currency} `;
  }
}

/**
 * Determine the unit family for a given AWS pricing unit string.
 *
 * - "byte": storage units that should render as GB / TB
 * - "count": request/event count units that render with k/M/B suffix
 * - "compute-second": Lambda/compute GB-Second units (M/B suffix + label)
 * - "unknown": everything else — render as raw number + unit string
 */
function unitFamily(
  unit: string,
): "byte" | "count" | "compute-second" | "unknown" {
  const u = unit.toLowerCase();
  // Byte / storage units
  if (
    u === "gb" ||
    u === "gb-mo" ||
    u === "gb-month" ||
    u.startsWith("gb-mo") ||
    u === "tb" ||
    u === "tb-mo" ||
    u === "tb-month"
  ) {
    return "byte";
  }
  // Compute-second units (must check before generic count patterns)
  if (u.includes("gb-second") || u.includes("gb-seconds")) {
    return "compute-second";
  }
  // Count / event units
  const countKeywords = [
    "request",
    "notification",
    "publish",
    "message",
    "invocation",
    "call",
    "event",
    "query",
    "item",
    "read",
    "write",
    "unit",
  ];
  for (const kw of countKeywords) {
    if (u.includes(kw)) return "count";
  }
  // "million requests", "million publishes", etc.
  if (u.startsWith("million ") || u.startsWith("1 million")) return "count";
  return "unknown";
}

/**
 * Format a numeric count value with k/M/B suffix.
 * Uses toPrecision(3) then strips trailing zeros via unary + coercion.
 * e.g. 999_999 → "1M", 1_000_000 → "1M", 100_000_000 → "100M"
 */
function formatCount(value: number): string {
  if (value >= 1_000_000_000) {
    const b = +(value / 1_000_000_000).toPrecision(3);
    return `${b}B`;
  }
  if (value >= 1_000_000) {
    const m = +(value / 1_000_000).toPrecision(3);
    // Promote to next tier when toPrecision rounds across the boundary
    // (e.g. 999_999_999 / 1_000_000 = 999.999 → toPrecision(3) → 1_000).
    if (m >= 1000) return `${+(m / 1000).toPrecision(3)}B`;
    return `${m}M`;
  }
  if (value >= 1_000) {
    const k = +(value / 1_000).toPrecision(3);
    // Promote to next tier when toPrecision rounds across the boundary
    // (e.g. 999_999 / 1_000 = 999.999 → toPrecision(3) → 1_000).
    if (k >= 1000) return `${+(k / 1000).toPrecision(3)}M`;
    return `${k}k`;
  }
  return value.toLocaleString("en-US");
}

/**
 * Format a range value for display based on the pricing unit.
 *
 * Unit families:
 *   - Byte units (GB-Mo, GB-month, GB, TB-*): GB→TB at ≥512 GB.
 *   - Count units (Requests, Notifications, Publishes, …): k/M/B suffix.
 *   - Compute-second units (Lambda-GB-Second, GB-Second): M/B suffix + "GB-Seconds".
 *   - Default: raw number (locale-formatted) + unit string, NO TB conversion.
 *
 * AWS pricing pages show clean numbers like "10 TB" and "40 TB" for tier
 * boundaries that are slightly imprecise in GB (e.g. 10140 GB ≈ 10 TB,
 * 40960 GB ≈ 40 TB). We round to the nearest integer TB to match.
 *
 * @param value  Raw numeric tier boundary from the AWS Pricing API.
 * @param unit   Unit string from the price dimension (e.g. "GB-Mo", "Requests").
 */
export function formatRange(value: number, unit: string): string {
  const family = unitFamily(unit);

  switch (family) {
    case "byte": {
      if (value >= 512) {
        const tb = Math.round(value / 1024);
        return `${tb} TB`;
      }
      return `${value} GB`;
    }
    case "count": {
      return `${formatCount(value)} ${unit}`;
    }
    case "compute-second": {
      return `${formatCount(value)} GB-Seconds`;
    }
    default: {
      // Unknown unit — raw value + unit string, no TB conversion
      return `${value.toLocaleString("en-US")} ${unit}`;
    }
  }
}

/**
 * Format a per-unit rate for display.
 * Strips trailing zeros beyond 3 significant digits.
 */
function formatRate(rateStr: string, currency: string, unit: string): string {
  const rate = parseFloat(rateStr);
  const prefix = currencyPrefix(currency);
  let formatted: string;

  if (rate === 0) {
    return "free";
  }

  // Determine significant decimal places
  if (rate >= 0.01) {
    formatted = rate.toFixed(3);
  } else if (rate >= 0.0001) {
    formatted = rate.toFixed(4);
  } else {
    // Very small rate — use enough precision to be non-zero
    const decimals = Math.ceil(-Math.log10(rate)) + 3;
    formatted = rate.toFixed(decimals);
  }

  // Strip trailing zeros after decimal point (but keep at least 3 significant digits)
  // e.g. 0.090000000 → "0.090" → but we want 3 sig figs so keep "0.090"
  // Actually preserve exactly as formatted — AWS pricing strings have significance
  return `${prefix}${formatted}/${unit}`;
}

/**
 * Convert tiered priceDimensions to a render struct.
 *
 * Returns undefined when the tier ranges are non-monotonic (data error from AWS) —
 * caller falls back to "unavailable".
 *
 * Display rules:
 * - Tier with rate = 0: "free up to <range>"
 * - Paid tier: "$X.XXX/GB next <range>" or "$X.XXX/GB above <prev>"
 * - All-zero rates: "free across all tiers"
 * - Cap at 3 tiers in the text + "…" for the 4th+
 *   (but structured tiers array always has all tiers)
 */
export function renderTierLadder(
  priceDimensions: Record<string, FullPriceDimension>,
): TierLadderRender | undefined {
  const dims = Object.values(priceDimensions);

  // Sort by beginRange ascending
  const sorted = [...dims].sort(
    (a, b) => parseFloat(a.beginRange ?? "0") - parseFloat(b.beginRange ?? "0"),
  );

  // Validate monotonicity: each beginRange must equal the previous endRange
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const prevEnd = parseFloat(prev.endRange ?? "Inf");
    const currBegin = parseFloat(curr.beginRange ?? "0");
    if (!isNaN(prevEnd) && Math.abs(prevEnd - currBegin) > 0.001) {
      // Non-monotonic — log warning and return undefined
      console.warn(
        `[tier-ladder] Non-monotonic price dimensions detected: ` +
          `prevEnd=${prev.endRange}, currBegin=${curr.beginRange}. Falling back to unavailable.`,
      );
      return undefined;
    }
  }

  // Detect currency: use the first dimension's pricePerUnit keys
  const firstDim = sorted[0];
  if (!firstDim) return undefined;
  const pricePerUnit = firstDim.pricePerUnit ?? {};
  const currency =
    Object.keys(pricePerUnit).find((k) => k !== "USD") ??
    Object.keys(pricePerUnit)[0] ??
    "USD";
  const unit = firstDim.unit ?? "GB";

  // Build structured tiers
  const tiers: PriceTier[] = sorted.map((dim) => {
    const endRaw = dim.endRange;
    const endRange =
      endRaw === undefined || endRaw === "Inf" || endRaw === ""
        ? undefined
        : parseFloat(endRaw);
    return {
      beginRange: parseFloat(dim.beginRange ?? "0"),
      ...(endRange !== undefined ? { endRange } : {}),
      rate: dim.pricePerUnit?.[currency] ?? "0",
      currency,
      unit,
    };
  });

  // Check all-zero case
  const allZero = tiers.every((t) => parseFloat(t.rate) === 0);
  if (allZero) {
    return { text: "free across all tiers", tiers };
  }

  // Build text segments — cap at 3 tiers + ellipsis
  const MAX_DISPLAY_TIERS = 3;
  const segments: string[] = [];

  for (let i = 0; i < tiers.length && i < MAX_DISPLAY_TIERS; i++) {
    const tier = tiers[i]!;
    const rate = parseFloat(tier.rate);
    const hasEnd = tier.endRange !== undefined;

    if (rate === 0) {
      // Free tier
      if (hasEnd) {
        segments.push(`free up to ${formatRange(tier.endRange!, unit)}`);
      } else {
        segments.push("free");
      }
    } else {
      const rateStr = formatRate(tier.rate, currency, unit);
      if (i === 0) {
        // First tier (paid from the start)
        if (hasEnd) {
          segments.push(
            `${rateStr} up to ${formatRange(tier.endRange!, unit)}`,
          );
        } else {
          segments.push(rateStr);
        }
      } else {
        // Subsequent paid tier — show the tier width as "next N <unit>"
        // The width is endRange - prevEnd (approximately how much usage
        // falls into this tier). For byte units, formatRange rounds to nearest
        // integer TB; for count/compute units it renders with k/M/B suffix.
        const prevEnd = tiers[i - 1]!.endRange;
        if (hasEnd && prevEnd !== undefined) {
          const width = tier.endRange! - prevEnd;
          segments.push(`${rateStr} next ${formatRange(width, unit)}`);
        } else if (prevEnd !== undefined) {
          segments.push(`${rateStr} above ${formatRange(prevEnd, unit)}`);
        } else {
          segments.push(rateStr);
        }
      }
    }
  }

  if (tiers.length > MAX_DISPLAY_TIERS) {
    segments.push("…");
  }

  return { text: segments.join(", "), tiers };
}
