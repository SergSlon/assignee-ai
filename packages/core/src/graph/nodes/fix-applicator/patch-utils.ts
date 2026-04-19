/**
 * Patch utilities — deep-merge patches, compare/apply-already-applied,
 * and extract old/new leaf values for display.
 *
 * Pure functions only. No clack, no logger, no state — safe to unit-test in
 * isolation.
 *
 * Wave-6c F3: extracted from fix-applicator.ts (SRP).
 */

import { PROTO_POLLUTION_KEYS } from "@/config/constants/security.js";
import { wizardKeyMap } from "@/utils/wizard-key-map.js";

/**
 * Deep-merge a patch object into a target object.
 * Arrays in the patch are merged element-by-element (patch[i] merged into target[i]).
 * Scalar values in the patch overwrite the target.
 */
export function deepMergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, patchValue] of Object.entries(patch)) {
    // Prototype pollution guard: reject __proto__, constructor, prototype keys
    if (PROTO_POLLUTION_KEYS.has(key)) {
      continue;
    }
    const targetValue = result[key];

    if (Array.isArray(patchValue) && Array.isArray(targetValue)) {
      const merged = [...targetValue];
      for (let i = 0; i < patchValue.length; i++) {
        if (
          i < merged.length &&
          typeof merged[i] === "object" &&
          merged[i] !== null &&
          typeof patchValue[i] === "object" &&
          patchValue[i] !== null &&
          !Array.isArray(patchValue[i])
        ) {
          merged[i] = deepMergePatch(
            merged[i] as Record<string, unknown>,
            patchValue[i] as Record<string, unknown>,
          );
        } else if (i < merged.length) {
          merged[i] = patchValue[i];
        } else {
          merged.push(patchValue[i]);
        }
      }
      result[key] = merged;
    } else if (
      typeof patchValue === "object" &&
      patchValue !== null &&
      !Array.isArray(patchValue) &&
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMergePatch(
        targetValue as Record<string, unknown>,
        patchValue as Record<string, unknown>,
      );
    } else {
      result[key] = patchValue;
    }
  }

  return result;
}

/**
 * Check if the user explicitly set a field that a patch would modify.
 * Walks the patch keys and checks if elicitedOptions contains a matching key path.
 */
export function isFieldExplicitlySet(
  elicitedOptions: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): boolean {
  if (!elicitedOptions) return false;

  for (const key of Object.keys(patch)) {
    if (key in elicitedOptions) return true;

    const wizardKeys = wizardKeyMap[key];
    if (wizardKeys === undefined) {
      if (key in elicitedOptions) return true;
      continue;
    }
    if (wizardKeys.some((wk) => wk in elicitedOptions)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract the "old value" from desiredState by walking the same nested path
 * as the patch, so the display shows the actual value being replaced (leaf),
 * not the entire top-level object.
 */
export function extractOldValue(
  desiredState: Record<string, unknown>,
  patch: Record<string, unknown>,
): unknown {
  let current: unknown = desiredState;
  let patchLevel: unknown = patch;

  while (
    typeof patchLevel === "object" &&
    patchLevel !== null &&
    !Array.isArray(patchLevel)
  ) {
    const keys = Object.keys(patchLevel as Record<string, unknown>);
    if (keys.length === 0) break;
    const key = keys[0]!;
    const nextPatch = (patchLevel as Record<string, unknown>)[key];
    if (
      typeof current === "object" &&
      current !== null &&
      !Array.isArray(current)
    ) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
    if (
      typeof nextPatch !== "object" ||
      nextPatch === null ||
      Array.isArray(nextPatch)
    ) {
      return current;
    }
    patchLevel = nextPatch;
  }

  return current;
}

/** Extract the "new value" (first leaf) from a patch for display. */
export function extractNewValue(patch: Record<string, unknown>): unknown {
  const firstKey = Object.keys(patch)[0];
  if (!firstKey) return undefined;
  const val = patch[firstKey];
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    return extractNewValue(val as Record<string, unknown>);
  }
  return val;
}

/** Extract the field path description from a patch for display. */
export function extractFieldPath(patch: Record<string, unknown>): string {
  const parts: string[] = [];
  let current: unknown = patch;

  while (
    typeof current === "object" &&
    current !== null &&
    !Array.isArray(current)
  ) {
    const keys = Object.keys(current as Record<string, unknown>);
    if (keys.length === 0) break;
    parts.push(keys[0]!);
    current = (current as Record<string, unknown>)[keys[0]!];
  }

  return parts.join(".");
}

/**
 * Check if every key-value in a patch already exists in the target state.
 * Walks the patch tree recursively and compares leaf values.
 */
export function isPatchAlreadyApplied(
  state: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  for (const [key, patchValue] of Object.entries(patch)) {
    const stateValue = state[key];
    if (
      typeof patchValue === "object" &&
      patchValue !== null &&
      !Array.isArray(patchValue)
    ) {
      if (
        typeof stateValue !== "object" ||
        stateValue === null ||
        Array.isArray(stateValue)
      ) {
        return false;
      }
      if (
        !isPatchAlreadyApplied(
          stateValue as Record<string, unknown>,
          patchValue as Record<string, unknown>,
        )
      ) {
        return false;
      }
    } else {
      if (JSON.stringify(stateValue) !== JSON.stringify(patchValue)) {
        return false;
      }
    }
  }
  return true;
}
