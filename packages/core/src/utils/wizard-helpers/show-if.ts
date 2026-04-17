/**
 * showIf condition resolution + per-field fetch keying.
 * Pure functions — no I/O, no mutation.
 */

import type { ResourceField } from "@assignee/core";

/** Unique key for a field in fetchResults — disambiguates fields sharing the same name (e.g., EngineVersion per engine). */
export function fieldFetchKey(field: ResourceField): string {
  if (field.question.showIf) {
    const cond = field.question.showIf;
    const suffix = cond.pattern ?? String(cond.value);
    return `${field.name}::${cond.field}=${suffix}`;
  }
  return field.name;
}

/**
 * Evaluates a showIf condition against the current field answers.
 * Supports exact `value` match and regex `pattern` match.
 */
export function evaluateShowIf(
  condition: { field: string; value?: unknown; pattern?: string },
  answers: Record<string, unknown>,
): boolean {
  const depValue = answers[condition.field];
  if (condition.pattern) {
    return new RegExp(condition.pattern).test(String(depValue ?? ""));
  }
  // When value is boolean true, treat as a truthy check (supports arrays, strings, etc.)
  if (condition.value === true) {
    if (Array.isArray(depValue)) return depValue.length > 0;
    return !!depValue;
  }
  if (condition.value === false) {
    if (Array.isArray(depValue)) return depValue.length === 0;
    return !depValue;
  }
  return depValue === condition.value;
}
