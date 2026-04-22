/**
 * Expert-mode (`--no-wizard`) fast path.
 *
 * Story 42.1: auto-decide everything using plugin defaults + intent
 * analysis. The wizard is opt-in via --wizard. Missing required fields
 * are allowed — the plan-generator LLM will extract them from the
 * user intent.
 *
 * Story 42.3: Merge intent-derived overrides into defaults
 * (SSH → KeyName + PublicIP, etc.).
 *
 * Wave-6c F3: extracted from option-elicitor.ts (SRP).
 *
 * Epic 94 R3 (B-01): intent-parser writes complex values such as
 * `elicitedOptions.SecurityGroupIngress = [{FromPort:22,...}]` into
 * `state.elicitedOptions` BEFORE this node runs (`mergeElicited` in
 * intent-parser). Array/object values are not mirrored into
 * `presetFields` (see `mergePresetFields` in intent-parser.ts), so the
 * only surviving copy is in `state.elicitedOptions`. We must therefore
 * seed from `state.elicitedOptions` here; plugin defaults and
 * `initialValue`s fill ONLY gaps the intent-parser did not set, and
 * `presetElicited` (from `--set` flags) retains final-override
 * precedence so explicit operator overrides still win.
 */

import { defaultPluginRegistry } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { getIntentDefaults } from "@/utils/intent-defaults/index.js";

/** Produce elicitedOptions without any interactive prompts. */
export function buildExpertModeOptions(
  state: AgentState,
  presetElicited: Record<string, unknown>,
): Record<string, unknown> {
  const plugin =
    defaultPluginRegistry.get(state.resourceType) ??
    defaultPluginRegistry.get("generic")!;

  const intentOverrides = getIntentDefaults(
    state.userIntent,
    state.resourceType,
  );
  const intentMap = new Map(intentOverrides.map((o) => [o.fieldName, o.value]));

  // Start from intent-parser's writes so array/object assertions
  // (SecurityGroupIngress, etc.) survive.
  const parserAsserted: Record<string, unknown> = {
    ...(state.elicitedOptions ?? {}),
  };

  const elicitedOptions: Record<string, unknown> = {};
  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  for (const field of allFields) {
    if (field.question.showIf) continue;
    const parserVal = parserAsserted[field.name];
    const intentVal = intentMap.get(field.name);
    const iv = field.question.initialValue;
    const pd = plugin.defaults[field.name];
    // Precedence: parser > intent-rules > plugin initialValue > plugin default.
    if (parserVal !== undefined) elicitedOptions[field.name] = parserVal;
    else if (intentVal !== undefined) elicitedOptions[field.name] = intentVal;
    else if (iv !== undefined) elicitedOptions[field.name] = iv;
    else if (pd !== undefined) elicitedOptions[field.name] = pd;
  }

  // Preserve any parser writes whose key isn't a plugin field (e.g. `__noVpc`
  // directives or computed hints the plugin doesn't declare).
  for (const [key, value] of Object.entries(parserAsserted)) {
    if (!(key in elicitedOptions)) elicitedOptions[key] = value;
  }

  return { ...elicitedOptions, ...presetElicited };
}
