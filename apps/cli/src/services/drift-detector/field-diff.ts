/**
 * Deep field-by-field diff between desired and actual resource state.
 *
 * Honors the auto-populated field allowlist from @assignee/core so that
 * AWS-managed attributes (e.g., `Arn`, `CreationDate`) never appear as drift.
 *
 * Extracted from drift-detector.ts during Wave-6c decomposition.
 *
 * @see Story 28.1
 */

import {
  ChangeType,
  isAutoPopulatedField,
  type DriftedField,
} from "@assignee/core";
import { canonicalSort, deepEqual } from "./canonical.js";
import { normalizeValue } from "./normalize.js";

/**
 * Deep diff two objects. Returns an array of drifted fields.
 *
 * @param desired - Expected state from provision log
 * @param actual - Actual state from CloudControl
 * @param resourceType - For auto-populated field exclusion
 * @param prefix - Current path prefix for nested keys
 */
export function deepDiff(
  desired: Record<string, unknown>,
  actual: Record<string, unknown>,
  resourceType: string,
  prefix = "",
): DriftedField[] {
  const fields: DriftedField[] = [];
  const allKeys = new Set([...Object.keys(desired), ...Object.keys(actual)]);

  for (const key of allKeys) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    // Skip auto-populated fields
    if (isAutoPopulatedField(resourceType, fieldPath)) {
      continue;
    }

    const desiredVal = desired[key];
    const actualRaw = actual[key];
    const actualVal = normalizeValue(actualRaw, desiredVal);

    const desiredPresent =
      key in desired && desiredVal !== undefined && desiredVal !== null;
    const actualPresent =
      key in actual && actualRaw !== undefined && actualRaw !== null;

    // Handle null/undefined equivalence for optional fields
    if (!desiredPresent && !actualPresent) {
      continue;
    }

    // Present only in actual → added externally
    if (!desiredPresent && actualPresent) {
      fields.push({
        path: fieldPath,
        desiredValue: undefined,
        actualValue: actualVal,
        changeType: ChangeType.ADDED_EXTERNALLY,
      });
      continue;
    }

    // Present only in desired → removed
    if (desiredPresent && !actualPresent) {
      fields.push({
        path: fieldPath,
        desiredValue: desiredVal,
        actualValue: undefined,
        changeType: ChangeType.REMOVED,
      });
      continue;
    }

    // Both present — compare recursively for objects
    if (
      typeof desiredVal === "object" &&
      desiredVal !== null &&
      typeof actualVal === "object" &&
      actualVal !== null &&
      !Array.isArray(desiredVal) &&
      !Array.isArray(actualVal)
    ) {
      const nested = deepDiff(
        desiredVal as Record<string, unknown>,
        actualVal as Record<string, unknown>,
        resourceType,
        fieldPath,
      );
      fields.push(...nested);
      continue;
    }

    // Array comparison
    if (Array.isArray(desiredVal) && Array.isArray(actualVal)) {
      const arrayDiffs = diffArrays(
        desiredVal,
        actualVal,
        resourceType,
        fieldPath,
      );
      fields.push(...arrayDiffs);
      continue;
    }

    // Primitive comparison
    if (desiredVal !== actualVal) {
      // Deep equality check for non-primitive values (order-independent)
      if (
        typeof desiredVal === "object" &&
        typeof actualVal === "object" &&
        deepEqual(desiredVal, actualVal)
      ) {
        continue;
      }
      fields.push({
        path: fieldPath,
        desiredValue: desiredVal,
        actualValue: actualVal,
        changeType: ChangeType.MODIFIED,
      });
    }
  }

  return fields;
}

/**
 * Diff two arrays element-by-element after canonical sort, so ordering
 * differences in e.g. tag lists or security-group rules do not produce
 * spurious drift.
 */
function diffArrays(
  desired: unknown[],
  actual: unknown[],
  resourceType: string,
  prefix: string,
): DriftedField[] {
  // Canonically sort both arrays to avoid false drift from ordering differences
  const sortedDesired = canonicalSort(desired) as unknown[];
  const sortedActual = canonicalSort(actual) as unknown[];

  const fields: DriftedField[] = [];
  const maxLen = Math.max(sortedDesired.length, sortedActual.length);

  for (let i = 0; i < maxLen; i++) {
    const path = `${prefix}[${i}]`;

    if (i >= sortedDesired.length) {
      // Added externally
      fields.push({
        path,
        desiredValue: undefined,
        actualValue: sortedActual[i],
        changeType: ChangeType.ADDED_EXTERNALLY,
      });
      continue;
    }

    if (i >= sortedActual.length) {
      // Removed
      fields.push({
        path,
        desiredValue: sortedDesired[i],
        actualValue: undefined,
        changeType: ChangeType.REMOVED,
      });
      continue;
    }

    const d = sortedDesired[i];
    const a = sortedActual[i];

    // If both are objects, deep diff
    if (
      typeof d === "object" &&
      d !== null &&
      typeof a === "object" &&
      a !== null &&
      !Array.isArray(d) &&
      !Array.isArray(a)
    ) {
      const nested = deepDiff(
        d as Record<string, unknown>,
        a as Record<string, unknown>,
        resourceType,
        path,
      );
      fields.push(...nested);
      continue;
    }

    const normalizedA = normalizeValue(a, d);
    if (d !== normalizedA) {
      // Order-independent deep equality check
      if (
        typeof d === "object" &&
        typeof normalizedA === "object" &&
        deepEqual(d, normalizedA)
      ) {
        continue;
      }
      fields.push({
        path,
        desiredValue: d,
        actualValue: normalizedA,
        changeType: ChangeType.MODIFIED,
      });
    }
  }

  return fields;
}
