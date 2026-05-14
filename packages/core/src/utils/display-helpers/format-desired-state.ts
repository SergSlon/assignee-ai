/**
 * Formats a desiredState record as a human-readable key-value table.
 */
import { resolveFieldLabel } from "./friendly-names-by-type.js";
import { SENSITIVE_FIELDS } from "./sensitive-fields.js";
import { formatValue } from "./format-value.js";
import { formatSpecialValue } from "./format-special-value.js";
import { RDS_REQUIRED_PASSWORD_PLACEHOLDER } from "@/config/placeholder-passwords.js";

/** Display token for a redacted (real) sensitive value. */
export const MASKED_DISPLAY = "<<masked>>";

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
    // EPIC-106-4 / PH5-4-A: underscore-prefix keys are internal fields
    // (e.g. _resourceId, _provisionRecord, _VpcDefaultHint) — never render.
    if (key.startsWith("_")) continue;
    const friendlyKey = resolveFieldLabel(key, resourceType);
    const padded = friendlyKey.padEnd(maxKeyLen);
    // Mask sensitive fields — never display passwords/secrets in plaintext.
    // Exception: if the value IS the actionable placeholder string (Solution C
    // / RG-1), show it verbatim so the user sees the required action hint.
    if (SENSITIVE_FIELDS.has(key) && value !== undefined && value !== null) {
      const display =
        value === RDS_REQUIRED_PASSWORD_PLACEHOLDER
          ? String(value)
          : MASKED_DISPLAY;
      lines.push(`  ${padded}   ${display}`);
      continue;
    }
    const formatted = formatSpecialValue(key, value) ?? formatValue(value);
    // SX-5 / PH1-F-2: suppress rows whose rendered value is an empty string
    // (e.g. VPCSecurityGroupIds: [], Comment: ""). An empty render looks like
    // a corruption artefact; the user gains nothing from seeing a blank row.
    if (formatted === "") continue;
    lines.push(`  ${padded}   ${formatted}`);
  }

  return lines.join("\n");
}
