/**
 * Intent defaults resolver — pure functions that apply INTENT_RULES to
 * a resource-type + user-intent pair, producing field overrides.
 */

import { CfnKey } from "@assignee/core";
import type { ResourceField } from "@assignee/core";
import type { IntentDefaultOverride } from "./types.js";
import { INTENT_RULES } from "./registry.js";

/**
 * Analyzes the user intent string and returns field default overrides
 * for the given resource type. Uses case-insensitive substring matching.
 * First matching rule per field wins — no conflicting overrides.
 *
 * @param userIntent  - The user's natural-language intent string
 * @param resourceType - CloudFormation resource type, e.g. RESOURCE_TYPES.EC2_INSTANCE
 * @returns Array of field overrides (empty if no keywords match)
 */
export function getIntentDefaults(
  userIntent: string,
  resourceType: string,
): IntentDefaultOverride[] {
  if (!userIntent || !resourceType) return [];

  const intentLower = userIntent.toLowerCase();
  const claimedFields = new Set<string>();
  const overrides: IntentDefaultOverride[] = [];

  for (const rule of INTENT_RULES) {
    if (rule.resourceType !== resourceType) continue;

    const matches = rule.keywords.some((kw) => intentLower.includes(kw));
    if (!matches) continue;

    for (const override of rule.overrides) {
      // First match per field wins
      if (claimedFields.has(override.fieldName)) continue;
      claimedFields.add(override.fieldName);
      overrides.push(override);
    }
  }

  return overrides;
}

/**
 * Applies intent-derived default overrides to resource fields.
 * Modifies initialValue and appends reason hint to each matching field.
 * Pure function — no mutations to input arrays.
 */
export function applyIntentOverrides(
  fields: ResourceField[],
  overrides: IntentDefaultOverride[],
): ResourceField[] {
  if (overrides.length === 0) return fields;

  const overrideMap = new Map(overrides.map((o) => [o.fieldName, o]));

  return fields.map((field) => {
    const override = overrideMap.get(field.name);
    if (!override) return field;

    const intentHint = `Pre-selected based on your intent: ${override.reason}`;
    const existingHint = field.question.hint;
    const combinedHint = existingHint
      ? `${existingHint}\n${intentHint}`
      : intentHint;

    // Special warning for PublicAccessBlock=false
    const finalHint =
      field.name === CfnKey.PUBLIC_ACCESS_BLOCK && override.value === false
        ? `${combinedHint}\nWarning: Public access will be enabled. Ensure this bucket does not contain sensitive data.`
        : combinedHint;

    const updatedQuestion = {
      ...field.question,
      initialValue: override.value,
      hint: finalHint,
    };

    // For enum fields, inject the override value as an option if not already listed
    if (
      updatedQuestion.type === "enum" &&
      typeof override.value === "string" &&
      override.value.length > 0 &&
      !(updatedQuestion.options ?? []).some(
        (o: { value: string }) => o.value === override.value,
      )
    ) {
      updatedQuestion.options = [
        {
          value: override.value as string,
          label: `${override.value} (auto-create)`,
        },
        ...(updatedQuestion.options ?? []),
      ];
    }

    return { ...field, question: updatedQuestion };
  });
}
