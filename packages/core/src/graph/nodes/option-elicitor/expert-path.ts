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
 */

import { defaultPluginRegistry } from "../../../index.js";
import type { AgentState } from "../../graph-state.js";
import { getIntentDefaults } from "../../../utils/intent-defaults/index.js";

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

  const elicitedOptions: Record<string, unknown> = {};
  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  for (const field of allFields) {
    if (field.question.showIf) continue;
    const intentVal = intentMap.get(field.name);
    const iv = field.question.initialValue;
    const pd = plugin.defaults[field.name];
    if (intentVal !== undefined) elicitedOptions[field.name] = intentVal;
    else if (iv !== undefined) elicitedOptions[field.name] = iv;
    else if (pd !== undefined) elicitedOptions[field.name] = pd;
  }

  return { ...elicitedOptions, ...presetElicited };
}
