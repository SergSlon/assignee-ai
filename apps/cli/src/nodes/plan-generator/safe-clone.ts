/**
 * Safe deep-clone + resourceId redaction for plan-generator.
 *
 * Extracted from plan-generator.ts (Wave-6 F2 SOLID refactor). Owns one
 * concern: enforcing that a `desiredState` is a plain JSON-ish
 * Record<string, unknown>, cloning it via structuredClone with an
 * actionable failure message, and redacting tenant-revealing resourceIds
 * from wrapped error messages.
 */
import { createHash } from "node:crypto";

/**
 * R3-D/W5-F3 L3: redact resourceId for multi-tenant SaaS log safety.
 *
 * The wrapped DataCloneError / shape-violation errors previously embedded
 * the full resourceId which can encode tenant intent (e.g.
 * "my-prod-db-secrets-bucket"). In shared log sinks this leaks tenant
 * data. Short ids (<=32 chars) pass through verbatim so local-dev
 * triage remains readable; longer ids are truncated to 32 chars +
 * short sha256 suffix for stable de-duplication without disclosure.
 *
 * Algorithm (stable):
 *   - If resourceId.length <= 32 → unchanged.
 *   - Else → `${resourceId.slice(0, 32)}…#${sha256(resourceId).slice(0, 8)}`.
 *
 * Exported for unit tests.
 */
export function redactResourceId(resourceId: string): string {
  if (resourceId.length <= 32) return resourceId;
  const hash = createHash("sha256")
    .update(resourceId)
    .digest("hex")
    .slice(0, 8);
  return `${resourceId.slice(0, 32)}…#${hash}`;
}

/**
 * P1-R2-8: safe wrapper around structuredClone for desiredState deep-copies.
 *
 * The Wave-3 F9 swap from `JSON.parse(JSON.stringify(x))` to structuredClone
 * introduced a new failure surface: structuredClone throws DataCloneError on
 * functions, class instances with private fields, symbols, Error instances,
 * WeakMap/WeakSet, etc. The JSON-based clone silently coerced / dropped
 * these; structuredClone raises. That's the correct new behavior, but we
 * need to (a) fail fast with an actionable message and (b) assert the shape
 * contract — desiredState must be a plain JSON-ish Record<string, unknown>.
 *
 * Exported for unit tests (see plan-generator.safeClone.test.ts).
 */
export function safeCloneDesiredState(
  desiredState: unknown,
  resourceId: string,
): Record<string, unknown> {
  // Runtime shape assertion: CFN CloudControl desiredState is always a
  // plain object. Arrays, null, primitives, functions, class instances
  // are contract violations from upstream (plugin.toCfn, LLM output,
  // pattern.defaultOptions).
  const safeId = redactResourceId(resourceId);
  if (
    desiredState === null ||
    typeof desiredState !== "object" ||
    Array.isArray(desiredState)
  ) {
    throw new TypeError(
      `plan-generator: desiredState for '${safeId}' must be a plain object (Record<string, unknown>); got ${
        Array.isArray(desiredState) ? "array" : typeof desiredState
      }. Check plugin.toCfn / pattern.defaultOptions output.`,
    );
  }
  try {
    return structuredClone(desiredState) as Record<string, unknown>;
  } catch (err) {
    // DataCloneError is the documented throw for non-serializable values.
    // Surface an actionable hint — JSON-clone would have silently dropped
    // these; structuredClone raises, which catches real bugs sooner.
    // resourceId is redacted (see redactResourceId) to prevent tenant
    // intent leakage in multi-tenant SaaS log sinks (R3-D P3).
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `plan-generator: desiredState for '${safeId}' contains non-serializable value (functions, class instances, symbols, Error, WeakMap/WeakSet are not allowed in CloudControl desiredState). Check plugin.toCfn output. Underlying: ${reason}`,
    );
  }
}
