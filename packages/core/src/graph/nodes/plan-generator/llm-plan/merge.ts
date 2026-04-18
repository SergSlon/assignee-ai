/**
 * LLM-plan phase 2: plugin placeholder-strip + elicitedOptions merge.
 *
 * Responsible for:
 *   - Stripping plugin-registered empty/placeholder values.
 *   - Stripping hallucinated ARNs (per
 *     `feedback_placeholder_arn_preflight_guard.md` — LLMs sometimes emit
 *     `arn:aws:iam::123456789012:...` placeholders).
 *   - Merging user-confirmed `elicitedOptions` over the LLM output (applying
 *     `toCfn` transforms to convert boolean answers to valid CFN structures).
 *   - Deleting LLM-generated values that the user explicitly declined (toCfn
 *     returned undefined — e.g., user answered "No" to BucketEncryption).
 *
 * SRP: one reason to change — how plugin fields and user-elicited values
 * combine with LLM output.
 */
import { defaultPluginRegistry } from "../../../../index.js";
import type { ResourceField } from "../../../../resource-plugins/types.js";
import type { AgentState } from "../../../graph-state.js";
import { applyToCfnTransforms } from "../cfn-emitter.js";
import {
  collectPluginPlaceholders,
  stripEmpty,
  stripPlaceholderArns,
} from "../placeholders.js";

/**
 * Removes empty + placeholder values emitted by the LLM so that plugin
 * defaults or user-elicited values land on a clean slate.
 */
export function stripPlaceholders(
  desiredState: Record<string, unknown>,
  resourceType: string,
): Record<string, unknown> {
  const pluginPlaceholders = collectPluginPlaceholders(resourceType);
  const stripped = stripEmpty(desiredState, pluginPlaceholders);
  stripPlaceholderArns(stripped);
  return stripped;
}

/**
 * Merges `elicitedOptions` (user-confirmed values) over the LLM-generated
 * desired state. Applies `toCfn` transforms to convert boolean answers into
 * valid CFN structures, then deletes any LLM-generated value that the user
 * explicitly declined (toCfn returned `undefined`).
 *
 * Returns `desiredState` unchanged when there are no elicited options.
 */
export function mergeElicitedOptions(
  desiredState: Record<string, unknown>,
  state: AgentState,
): Record<string, unknown> {
  if (
    !state.elicitedOptions ||
    Object.keys(state.elicitedOptions).length === 0
  ) {
    return desiredState;
  }

  const transformed = applyToCfnTransforms(
    state.elicitedOptions,
    state.resourceType ?? "",
  );
  const merged: Record<string, unknown> = { ...desiredState, ...transformed };

  // Delete LLM-generated values that the user explicitly declined
  // (toCfn returned undefined).
  const plugin = defaultPluginRegistry.get(state.resourceType ?? "");
  if (!plugin) return merged;

  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  for (const [key, value] of Object.entries(state.elicitedOptions)) {
    const field = resolveFieldForKey(allFields, key, state.elicitedOptions);
    if (field?.toCfn && field.toCfn(value) === undefined) {
      delete merged[key];
    }
  }
  return merged;
}

/**
 * Resolves the plugin field matching `key`. Prefers the `showIf`-matching
 * variant (so conditional fields with the same name don't get short-circuited
 * by a stale branch), then falls back to any field with that name.
 */
function resolveFieldForKey(
  allFields: ResourceField[],
  key: string,
  elicitedOptions: Record<string, unknown>,
): ResourceField | undefined {
  return (
    allFields.find((f) => {
      if (f.name !== key) return false;
      if (!f.question.showIf) return true;
      const { field: depField, value: depValue } = f.question.showIf;
      return elicitedOptions[depField] === depValue;
    }) ?? allFields.find((f) => f.name === key)
  );
}
