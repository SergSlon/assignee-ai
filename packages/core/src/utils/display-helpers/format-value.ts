/**
 * Value formatter for primitive/array/object CFN values.
 * Returns null safe, booleans → Yes/No, arrays → joined, objects → summarized.
 */
import { CfnKey } from "../../config/cfn-keys/keys.js";

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) {
    // Arrays of objects (e.g., Tags [{Key, Value}]) — show as Key:Value pairs
    if (
      value.length > 0 &&
      typeof value[0] === "object" &&
      value[0] !== null &&
      "Key" in value[0]
    ) {
      return value
        .map(
          (item: Record<string, unknown>) =>
            `${item[CfnKey.TAG_KEY]}:${item[CfnKey.TAG_VALUE]}`,
        )
        .join(", ");
    }
    return value.map((item) => formatValue(item)).join(", ");
  }
  if (typeof value === "object") {
    // Nested objects — show key: value pairs inline
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    // For deeply nested configs (e.g., encryption), summarize instead of dumping
    if (entries.length > 4) {
      return `${entries.length} properties configured`;
    }
    return entries.map(([k, v]) => `${k}: ${formatValue(v)}`).join(", ");
  }
  return String(value);
}
