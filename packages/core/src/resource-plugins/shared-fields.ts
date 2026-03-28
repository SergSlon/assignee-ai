/**
 * Shared field helpers for resource plugins.
 * Avoids duplicating validation logic across 20+ plugins.
 */

/**
 * Validates comma-separated Key:Value tag format.
 * Returns an error string if invalid, undefined if valid.
 */
export const TAGS_VALIDATE = (value: unknown): string | undefined => {
  if (!value) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  const pairs = s.split(",").map((p) => p.trim()).filter(Boolean);
  const valid = pairs.filter((p) => p.includes(":"));
  if (valid.length === 0) {
    return "Invalid tag format. Use Key:Value pairs separated by commas (e.g. env:production, team:backend)";
  }
  if (valid.length < pairs.length) {
    const invalid = pairs.filter((p) => !p.includes(":"));
    return `Some tags missing colon separator and will be ignored: ${invalid.join(", ")}`;
  }
  return undefined;
};
