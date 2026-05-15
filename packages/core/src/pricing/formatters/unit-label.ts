/**
 * Canonical unit-label formatter for per-million pricing rows.
 *
 * Chosen format: "$0.40/M requests"
 *   - Dollar sign + fixed decimal (2 or 4 places depending on magnitude)
 *   - "/M " prefix for the scale abbreviation
 *   - Pluralised unit noun (plural=true by default)
 *
 * This produces the priceUnit suffix that `extractFirstTierPrice` appends to
 * its formatted dollar amount, so callers store `formatUnitSuffix(unit)` as
 * the `priceUnit` field on a PricingLineItem and the render path handles the
 * dollar+decimal part automatically.
 *
 * Separate helper `formatPerUnit(value, unit, plural)` is provided for cases
 * where a fully-formed display label is needed (tests, snapshot guards).
 */

/**
 * Returns the canonical /M-suffix string for a given unit noun.
 * e.g. "request" → "/M requests", "publish" → "/M publishes"
 *
 * This is the string stored in `PricingLineItem.priceUnit` for per-million
 * items — `extractFirstTierPrice` appends it after the dollar amount.
 */
export function formatUnitSuffix(unit: string, plural = true): string {
  const noun = plural ? pluralise(unit) : unit;
  return `/M ${noun}`;
}

/**
 * Returns a fully-formed display label for a per-million rate.
 * e.g. formatPerUnit(0.4, "request") → "$0.40/M requests"
 *      formatPerUnit(1.03, "request") → "$1.03/M requests"
 *      formatPerUnit(0.4, "request", false) → "$0.40/M request"
 *
 * Dollar precision:
 *   - value >= 0.01  → 2 decimal places
 *   - value >= 0.0001 → 4 decimal places
 *   - smaller         → enough places to show at least 3 significant digits
 */
export function formatPerUnit(
  value: number,
  unit: string,
  plural = true,
): string {
  const decimals =
    value >= 0.01 ? 2 : value >= 0.0001 ? 4 : Math.ceil(-Math.log10(value)) + 3;
  return `$${value.toFixed(decimals)}${formatUnitSuffix(unit, plural)}`;
}

/** Minimal English pluralisation for the unit nouns used in decomposers. */
function pluralise(unit: string): string {
  const u = unit.toLowerCase();
  // Already plural
  if (u.endsWith("s")) return unit;
  // Irregular: publish → publishes
  if (
    u.endsWith("sh") ||
    u.endsWith("ch") ||
    u.endsWith("x") ||
    u.endsWith("z")
  ) {
    return `${unit}es`;
  }
  return `${unit}s`;
}
