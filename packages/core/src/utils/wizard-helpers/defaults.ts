/**
 * --no-wizard default population with two-pass fixpoint.
 *
 * Wave-2 P1-7 (2026-04-14): aggregate ALL missing dependent fields into a
 * single MissingRequiredFieldsError. See populateDefaultOptions JSDoc.
 */

import { MissingRequiredFieldsError } from "@assignee/core";
import type { ResourcePlugin } from "@assignee/core";
import { evaluateShowIf, fieldFetchKey } from "./show-if.js";

/**
 * Populates elicitedOptions from plugin defaults when --no-wizard is set.
 * Skips all interactive prompts. Throws MissingRequiredFieldsError if any
 * required field (marked `required: true`) has no initialValue and no plugin default.
 *
 * @param plugin - Resource plugin with field definitions and defaults
 * @returns Populated elicitedOptions record
 * @throws MissingRequiredFieldsError when required fields lack defaults
 */
export function populateDefaultOptions(
  plugin: ResourcePlugin,
): Record<string, unknown> {
  const elicitedOptions: Record<string, unknown> = {};
  const missingFields: string[] = [];

  const allFields = [...plugin.commonFields, ...plugin.advancedFields];

  // ── Pass 1: populate top-level (unconditional) fields ─────────────────
  for (const field of allFields) {
    if (field.question.showIf) continue;

    const initialValue = field.question.initialValue;
    const pluginDefault = plugin.defaults[field.name];

    if (initialValue !== undefined) {
      elicitedOptions[field.name] = initialValue;
    } else if (pluginDefault !== undefined) {
      elicitedOptions[field.name] = pluginDefault;
    } else if (field.required) {
      missingFields.push(field.name);
    }
  }

  // ── Pass 2: re-evaluate conditional fields against pass-1 answers ─────
  //
  // Wave-2 P1-7 (2026-04-14): previously all `showIf` fields were
  // silently skipped in `--no-wizard` mode. That meant a required
  // dependent field (e.g. RDS `EngineVersion` when `Engine` has a
  // default) would never raise `MissingRequiredFieldsError` and the
  // resource would ship with missing config. Now we evaluate each
  // `showIf` against the populated defaults — when the condition is
  // true we treat the field like a top-level one: populate a safe
  // default if one exists, else flag the field as missing and collect
  // *all* missing fields into a single error at the end.
  //
  // We iterate until fixpoint so a dependent field populated in this
  // pass can satisfy another field whose `showIf` depends on it.
  const processed = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const field of allFields) {
      if (!field.question.showIf) continue;
      const key = fieldFetchKey(field);
      if (processed.has(key)) continue;

      if (!evaluateShowIf(field.question.showIf, elicitedOptions)) {
        // Condition false — field genuinely doesn't apply. Do not flag.
        processed.add(key);
        continue;
      }

      processed.add(key);
      changed = true;

      const initialValue = field.question.initialValue;
      const pluginDefault = plugin.defaults[field.name];

      if (initialValue !== undefined) {
        elicitedOptions[field.name] = initialValue;
      } else if (pluginDefault !== undefined) {
        elicitedOptions[field.name] = pluginDefault;
      } else if (field.required) {
        missingFields.push(field.name);
      }
    }
  }

  if (missingFields.length > 0) {
    throw new MissingRequiredFieldsError(missingFields);
  }

  return elicitedOptions;
}
