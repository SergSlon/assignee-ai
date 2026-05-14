/**
 * Inline-name hint helper — emits the INFO advisory when a resource name
 * is extracted from the intent via the SX-2 inline pattern (e.g. "SNS topic
 * genai-events") instead of the explicit "named X" / "called X" keyword.
 *
 * The advisory tells the user we recognised their inline phrasing and
 * surfaces the recommended explicit form so a future intent can suppress
 * the INFO line.
 *
 * Confined to its own helper file so SX-2's advisory emit does not
 * collide with SX-6's `mcp-advisor.ts` work (per story SX-2 line 52).
 *
 * Closes Phase-1 finding PH1-C-1 + carryover DF-C1 (SNS topic name dropped).
 */

import type { Advisory } from "../intent-parser/intent-types.js";

/**
 * Build the INFO advisory describing an inline-name extraction.
 *
 * @param name      The extracted resource name (e.g. "genai-events").
 * @param property  The CFN property the name maps to (e.g. "TopicName").
 * @returns         A single `INLINE_NAME_DETECTED` advisory.
 */
export function inlineNameHint(name: string, property: string): Advisory {
  return {
    code: "INLINE_NAME_DETECTED",
    message: `Detected inline name '${name}' — using as ${property}.`,
    hint: `Use 'named ${name}' to suppress this hint.`,
  };
}

/**
 * Stable advisory code, exported so tests can assert against it without
 * duplicating the literal.
 */
export const INLINE_NAME_DETECTED_CODE = "INLINE_NAME_DETECTED";
