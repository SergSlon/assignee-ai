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
 *   - e96.W2.R5-part-2 — Injecting plugin-level `defaults` for keys the LLM
 *     omitted AND the user did not explicitly elicit. The compound-mode path
 *     in `compound-plan.ts` already spreads pattern defaults first-thing; LLM
 *     mode had no analogous step, so plugin defaults like
 *     `{CreditSpecification: {CPUCredits: "standard"}}` (seeded for the UX-
 *     polish of the "CPU Credits" plan row) never reached the display when
 *     the LLM didn't happen to emit them. Non-deterministic LLM drift made
 *     the row blank on ~60% of runs.
 *
 * SRP: one reason to change — how plugin fields and user-elicited values
 * combine with LLM output.
 */
import { defaultPluginRegistry, RESOURCE_TYPES } from "@/index.js";
import type { ResourceField } from "@/resource-plugins/types.js";
import type { AgentState } from "@/graph/graph-state.js";
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
 * Resource types whose plugin `defaults` should be backfilled into LLM
 * output for missing keys. Intentionally narrow — see the block comment
 * on `mergePluginDefaults` for the scoping rationale.
 *
 * e96.W2.R5-part-2 — seeded with EC2::Instance only (the finding that
 * prompted this helper). Broader rollout (e.g. S3) requires updating
 * the BP-enforcement integration tests that explicitly assert "the
 * plan is MISSING safety config → BP-S3-001 fires blocking." Those
 * tests validate that the safety net still catches bad plans, and a
 * plugin-default backfill for S3 would silently dismantle them.
 * Adding a new resource type here SHOULD come with a review of any
 * BP rules that fire on a missing default for that type.
 */
const LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST: readonly string[] = [
  RESOURCE_TYPES.EC2_INSTANCE,
];

/**
 * Injects plugin-level `defaults` for keys NOT already present in
 * `desiredState`. Runs AFTER `stripPlaceholders` + `mergeElicitedOptions`
 * and BEFORE `sanitizeAgainstSchema`, so:
 *
 *   1. LLM-emitted values win (plugin default does not clobber them).
 *   2. User-elicited values win (already merged in by
 *      `mergeElicitedOptions`; plugin default does not clobber them either).
 *   3. Plugin-default placeholders the LLM emitted verbatim have been
 *      stripped by `stripPlaceholders` first — so the injection fills the
 *      gap created by stripping, with the canonical plugin value.
 *   4. Downstream `sanitizeAgainstSchema` walks the CFN schema; any
 *      injected key that the schema rejects will be stripped cleanly
 *      rather than shipping a bad value.
 *
 * e96.W2.R5-part-2 — this is the missing analogue to compound-plan's
 * `{...patternDefaults, ...transformedOptions}` spread. Without it,
 * plugin defaults lived in the plugin but never reached the plan when
 * the LLM omitted the key entirely. Root cause of the C-01 regression
 * that survived the earlier casing-alignment fix.
 *
 * Scoped to resource types on `LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST`
 * (today: EC2::Instance only) because blanket backfill silently
 * dismantles BP-enforcement integration tests that rely on the LLM
 * producing a deliberately minimal plan — those tests assert
 * "blocking BP fires when safety config is missing." Backfilling
 * plugin defaults (e.g. S3 `PublicAccessBlockConfiguration`) would
 * auto-fix the plan and the BP would never fire. Add a new type to
 * the allowlist only after reviewing BP rules that fire on its
 * missing defaults.
 *
 * Returns `desiredState` unchanged when the plugin has no defaults
 * (most plugins don't) OR when `resourceType` is not on the allowlist.
 */
export function mergePluginDefaults(
  desiredState: Record<string, unknown>,
  resourceType: string,
): Record<string, unknown> {
  if (!resourceType) return desiredState;
  if (!LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST.includes(resourceType)) {
    return desiredState;
  }
  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin || !plugin.defaults) return desiredState;
  const keys = Object.keys(plugin.defaults);
  if (keys.length === 0) return desiredState;
  const result: Record<string, unknown> = { ...desiredState };
  for (const key of keys) {
    if (result[key] !== undefined) continue;
    const value = plugin.defaults[key];
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
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
