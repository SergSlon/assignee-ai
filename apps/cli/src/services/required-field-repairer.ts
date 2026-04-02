/**
 * Generic required-field repairer — fills missing required CloudFormation fields
 * from plugin defaults after LLM generation and sanitization.
 *
 * The plan-generator LLM sometimes omits required fields even when they're listed
 * in the prompt. Instead of one-off patches per resource type, this repairer
 * generically fills them from the plugin's declared defaults and initialValues.
 *
 * Priority order for each missing required field:
 * 1. plugin field `initialValue` (the value shown in the interactive wizard)
 * 2. plugin `defaults[fieldName]` (the plugin-level CloudFormation fallback)
 * 3. Skip — let preflight-guard report the truly missing field
 *
 * @see Story E2E.3 — Party mode consensus: generic required-field repairer
 */

import { defaultPluginRegistry } from "@assignee/core";
import { InjectionSource } from "../constants/field-policy.js";

export interface RepairResult {
  /** The repaired desiredState with missing required fields filled. */
  repaired: Record<string, unknown>;
  /** Fields that were injected with their source ("initialValue" | "pluginDefault"). */
  injectedFields: Array<{ field: string; source: string }>;
}

/**
 * Fills missing required CloudFormation fields from plugin defaults.
 *
 * Only injects values that the plugin explicitly defines — never guesses.
 * toCfn transforms are applied to injected values.
 *
 * @param desiredState - The LLM-generated + sanitized desiredState
 * @param resourceType - CloudFormation resource type (e.g. RESOURCE_TYPES.S3_BUCKET)
 * @param schemaRequired - Array of required field names from the CloudFormation schema
 * @returns Repaired desiredState with injection audit trail
 */
export function repairRequiredFields(
  desiredState: Record<string, unknown>,
  resourceType: string,
  schemaRequired: string[],
): RepairResult {
  const injectedFields: RepairResult["injectedFields"] = [];

  if (!resourceType || schemaRequired.length === 0) {
    return { repaired: desiredState, injectedFields };
  }

  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin) {
    return { repaired: desiredState, injectedFields };
  }

  const repaired = { ...desiredState };
  const allFields = [...plugin.commonFields, ...plugin.advancedFields];

  for (const requiredKey of schemaRequired) {
    // Skip if already present in desiredState
    if (requiredKey in repaired && repaired[requiredKey] !== undefined) {
      continue;
    }

    // Find the plugin field definition for this schema key
    const field = allFields.find((f) => f.name === requiredKey);

    // Try initialValue first (user-visible default)
    if (field?.question.initialValue !== undefined) {
      const value = field.toCfn
        ? field.toCfn(field.question.initialValue)
        : field.question.initialValue;
      if (value !== undefined) {
        repaired[requiredKey] = value;
        injectedFields.push({
          field: requiredKey,
          source: InjectionSource.INITIAL_VALUE,
        });
        continue;
      }
    }

    // Try plugin defaults (CloudFormation-level fallback)
    if (plugin.defaults[requiredKey] !== undefined) {
      repaired[requiredKey] = plugin.defaults[requiredKey];
      injectedFields.push({
        field: requiredKey,
        source: InjectionSource.PLUGIN_DEFAULT,
      });
      continue;
    }

    // Some toCfn fields map a plugin field name to a different CFN property name.
    // Check if any field's toCfn would produce this required key.
    // This handles cases like PartitionKey → KeySchema transform.
    if (field?.toCfn && field.question.initialValue !== undefined) {
      const cfnValue = field.toCfn(field.question.initialValue);
      if (cfnValue !== undefined) {
        repaired[requiredKey] = cfnValue;
        injectedFields.push({
          field: requiredKey,
          source: InjectionSource.INITIAL_VALUE_TO_CFN,
        });
      }
    }

    // No default available — skip. preflight-guard will report it.
  }

  return { repaired, injectedFields };
}
