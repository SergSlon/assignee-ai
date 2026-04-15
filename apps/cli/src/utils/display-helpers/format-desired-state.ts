/**
 * Formats a desiredState record as a human-readable key-value table.
 */
import { resolveFieldLabel } from "./friendly-names-by-type.js";
import { SENSITIVE_FIELDS } from "./sensitive-fields.js";
import { formatValue } from "./format-value.js";
import { formatSpecialValue } from "./format-special-value.js";

/**
 * Arrays are joined with commas. Objects render as nested key-value pairs.
 * Booleans render as "Yes"/"No". Strings and numbers render as-is.
 *
 * When `resourceType` is provided, per-resource label overrides from
 * FRIENDLY_NAMES_BY_TYPE take precedence over the global FRIENDLY_NAMES
 * map. This is required so ambiguous CFN property names like `Type` render
 * correctly per resource (e.g. SSM Parameter "Parameter Type" vs ELBv2
 * "Load Balancer Type").
 */
export function formatDesiredState(
  state: Record<string, unknown>,
  resourceType?: string,
): string {
  const entries = Object.entries(state);
  if (entries.length === 0) return "(none)";

  const lines: string[] = [];
  const maxKeyLen = Math.max(
    ...entries.map(([k]) => resolveFieldLabel(k, resourceType).length),
  );

  for (const [key, value] of entries) {
    const friendlyKey = resolveFieldLabel(key, resourceType);
    const padded = friendlyKey.padEnd(maxKeyLen);
    // Mask sensitive fields — never display passwords/secrets in plaintext
    if (SENSITIVE_FIELDS.has(key) && value !== undefined && value !== null) {
      lines.push(`  ${padded}   ********`);
      continue;
    }
    const formatted = formatSpecialValue(key, value) ?? formatValue(value);
    lines.push(`  ${padded}   ${formatted}`);
  }

  return lines.join("\n");
}
