/**
 * Trigger matcher — decides whether a BestPractice.trigger applies to the
 * current evaluation context. Split from evaluate.ts (W6d F3) as its own
 * routing concern: resource-type + intent keywords + pattern-id selection.
 */

import type { Trigger } from "../types.js";
import type { EvalContext } from "./context-builder.js";

/**
 * Check whether a single trigger matches the given evaluation context.
 * All set conditions use AND logic — every specified field must match.
 *
 * @param trigger - The trigger definition from a BestPractice
 * @param context - The current evaluation context
 * @returns true if the trigger matches
 */
export function matchesTrigger(
  trigger: Trigger,
  context: EvalContext,
): boolean {
  // resourceType filter — if set and does not match, skip
  if (
    trigger.resourceType !== undefined &&
    trigger.resourceType !== context.resourceType
  ) {
    return false;
  }

  // always — if true and resourceType matched (or not set), fire immediately
  if (trigger.always === true) {
    return true;
  }

  // intentKeywords — check if any keyword appears in userIntent (case-insensitive)
  if (
    trigger.intentKeywords !== undefined &&
    trigger.intentKeywords.length > 0
  ) {
    if (!context.userIntent) return false;
    const lowerIntent = context.userIntent.toLowerCase();
    const hasMatch = trigger.intentKeywords.some((kw) =>
      lowerIntent.includes(kw.toLowerCase()),
    );
    if (!hasMatch) return false;
  }

  // patternId — check exact match
  if (trigger.patternId !== undefined) {
    if (trigger.patternId !== context.patternId) return false;
  }

  // fieldCondition — evaluate against desiredState
  // fieldCondition is stored as a string in the Trigger type but not used
  // for direct evaluation here; field evaluation happens via BestPractice's
  // property_path/check_type/expected_value. The trigger-level fieldCondition
  // is for future use. For now, if set, we consider it matched (AND logic
  // with other conditions).

  return true;
}
