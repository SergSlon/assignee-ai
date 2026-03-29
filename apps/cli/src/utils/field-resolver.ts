/**
 * Field config resolution helpers extracted from option-elicitor.ts.
 * Provides the minimal resolveFieldConfigs function that maps plugin fields
 * to ResolvedFieldConfig entries using plugin initialValue as defaults.
 *
 * @see option-elicitor.ts for the main wizard loop that consumes these helpers.
 * @see merge-configs.ts for the full 6-level precedence mergeConfigs implementation.
 */

import type { ResourceField, ResolvedFieldConfig } from "@assignee/core";
import { FieldPolicy, FieldSource } from "../constants/field-policy.js";
import { fieldFetchKey } from "./wizard-helpers.js";

/**
 * Minimal config resolver used until Story 7.2 (mergeConfigs) is implemented.
 * Maps each plugin field to a ResolvedFieldConfig using plugin initialValue as default.
 * All fields are ask_if_not_set — no org locking or user config applied yet.
 */
export function resolveFieldConfigs(
  fields: ResourceField[],
): Record<string, ResolvedFieldConfig> {
  const result: Record<string, ResolvedFieldConfig> = {};
  for (const field of fields) {
    const pluginDefault = field.question.initialValue;
    const key = fieldFetchKey(field);
    result[key] =
      pluginDefault !== undefined
        ? {
            policy: FieldPolicy.ASK_IF_NOT_SET,
            value: pluginDefault,
            source: FieldSource.PLUGIN_DEFAULT,
          }
        : {
            policy: FieldPolicy.ALWAYS_ASK,
            source: FieldSource.PLUGIN_DEFAULT,
          };
  }
  return result;
}
