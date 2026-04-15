/**
 * Canonical sort + stable stringify + deep equality — order-independent
 * comparison primitives for drift detection.
 *
 * Extracted from drift-detector.ts during Wave-6c decomposition.
 *
 * @see Story 28.1
 */

/**
 * Recursively sort a value for order-independent comparison.
 * - Arrays of objects: sorted by canonical key (Key, FromPort, CidrIp, etc.)
 *   or stableStringify fallback.
 * - Arrays of primitives: sorted by value.
 * - Objects: keys sorted alphabetically, values recursively sorted.
 * - Primitives: returned as-is.
 */
export function canonicalSort(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    const sorted = value.map((item) => canonicalSort(item));
    sorted.sort((a, b) => {
      const aStr = stableStringify(a);
      const bStr = stableStringify(b);
      if (aStr < bStr) return -1;
      if (aStr > bStr) return 1;
      return 0;
    });
    return sorted;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      sortedObj[key] = canonicalSort(obj[key]);
    }
    return sortedObj;
  }

  return value;
}

/**
 * Produce a stable JSON string with sorted keys (for comparison purposes).
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * Deep equality check that is independent of key ordering and array element
 * ordering within nested structures.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  return (
    stableStringify(canonicalSort(a)) === stableStringify(canonicalSort(b))
  );
}
