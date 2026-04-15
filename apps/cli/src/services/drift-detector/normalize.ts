/**
 * Value normalization — handles AWS API quirks where numbers are sometimes
 * returned as strings, booleans as "true"/"false" strings, etc.
 *
 * PRESERVES Wave 2 P1-2 strict decimal parse:
 *   regex `/^-?(?:\d+\.?\d*|\.\d+)$/`
 *
 * Rejects:
 *   - empty string
 *   - leading/trailing whitespace
 *   - hex (0x10), octal (0o7), binary (0b101)
 *   - scientific notation ("1e3")
 *   - unicode digits outside ASCII 0-9
 *
 * AWS never returns scientific notation for numeric fields, so coercion to
 * a number there is a strong hallucination / injection signal — we leave
 * such strings as-is so the diff flags them.
 *
 * Extracted from drift-detector.ts during Wave-6c decomposition.
 *
 * @see Story 28.1
 */

/**
 * Normalize a value to handle AWS quirks:
 * - Stringified booleans → boolean
 * - Stringified numbers → number (only when desired is a number, strict decimal)
 * - null / undefined treated as equivalent
 */
export function normalizeValue(actual: unknown, desired: unknown): unknown {
  if (actual === null || actual === undefined) return undefined;
  if (desired === null || desired === undefined) return actual;

  // Coerce stringified booleans
  if (typeof actual === "string" && typeof desired === "boolean") {
    if (actual === "true") return true;
    if (actual === "false") return false;
  }

  // Coerce stringified numbers — STRICT decimal parse.
  // P1-2: `Number()` accepts "0x10" (hex), " 5 " (whitespace),
  // "" (→0), "1e3" → silently passing drift checks that should flag.
  // We require a plain decimal integer or float with no whitespace,
  // no hex/octal/binary prefixes, and no empty string.
  if (typeof actual === "string" && typeof desired === "number") {
    // Strict decimal: optional minus, digits, optional .digits.
    // Reject empty, whitespace, hex (0x), octal (0o), bin (0b),
    // scientific notation ("1e3"). AWS never returns scientific
    // notation for numeric fields, so this is a strong hallucination
    // signal when it appears.
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(actual)) {
      const num = Number(actual);
      if (Number.isFinite(num)) return num;
    }
    // Fall through: leave as original string so diff flags it.
  }

  return actual;
}
