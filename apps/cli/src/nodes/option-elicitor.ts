/**
 * option_elicitor node — interactively collects resource configuration from the user
 * before plan generation, using the ResourcePlugin field definitions from Story 7.1.
 *
 * Policy resolution: Story 7.2 (mergeConfigs) is not yet implemented.
 * Until then, all fields use plugin initialValue with ask_if_not_set policy.
 * When Story 7.2 lands, replace `resolveFieldConfigs()` with `mergeConfigs()`.
 *
 * @see Story 7.3
 */

import { ExecutionStatus, defaultPluginRegistry } from "@assignee/core";
import type { ResourceField, ResolvedFieldConfig } from "@assignee/core";
import { renderOptionPrompt, renderAdvancedConfirm } from "../utils/display.js";
import type { AgentState } from "../services/graph.js";

/**
 * Minimal config resolver used until Story 7.2 (mergeConfigs) is implemented.
 * Maps each plugin field to a ResolvedFieldConfig using plugin initialValue as default.
 * All fields are ask_if_not_set — no org locking or user config applied yet.
 */
function resolveFieldConfigs(
  fields: ResourceField[],
): Record<string, ResolvedFieldConfig> {
  const result: Record<string, ResolvedFieldConfig> = {};
  for (const field of fields) {
    const pluginDefault = field.question.initialValue;
    result[field.name] =
      pluginDefault !== undefined
        ? {
            policy: "ask_if_not_set",
            value: pluginDefault,
            source: "plugin_default",
          }
        : { policy: "always_ask", source: "plugin_default" };
  }
  return result;
}

export async function optionElicitorNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  // Non-TTY (CI/pipes): skip all prompts
  if (!process.stdin.isTTY) return { elicitedOptions: {} };

  const plugin =
    defaultPluginRegistry.get(state.resourceType) ??
    defaultPluginRegistry.get("generic")!;

  const resolvedCommon = resolveFieldConfigs(plugin.commonFields);
  const resolvedAdvanced = resolveFieldConfigs(plugin.advancedFields);

  const elicitedOptions: Record<string, unknown> = {};

  // ── Common tier ──────────────────────────────────────────────────────────────
  for (const field of plugin.commonFields) {
    const resolved = resolvedCommon[field.name];
    if (!resolved) continue;

    // showIf conditional — skip if condition not met
    if (field.question.showIf) {
      const depValue = elicitedOptions[field.question.showIf.field];
      if (depValue !== field.question.showIf.value) continue;
    }

    if (resolved.policy === "never_ask") {
      if (resolved.value !== undefined)
        elicitedOptions[field.name] = resolved.value;
      continue;
    }

    if (resolved.policy === "ask_if_not_set") {
      if (elicitedOptions[field.name] !== undefined) continue;
    }

    const answer = await renderOptionPrompt(field, resolved);
    if (answer !== undefined && answer !== "") {
      elicitedOptions[field.name] = answer;
    }
  }

  // ── Advanced tier gate ───────────────────────────────────────────────────────
  if (plugin.advancedFields.length > 0) {
    const showAdvanced = await renderAdvancedConfirm();
    if (showAdvanced) {
      for (const field of plugin.advancedFields) {
        const resolved = resolvedAdvanced[field.name];
        if (!resolved) continue;

        if (field.question.showIf) {
          const depValue = elicitedOptions[field.question.showIf.field];
          if (depValue !== field.question.showIf.value) continue;
        }

        if (resolved.policy === "never_ask") {
          if (resolved.value !== undefined)
            elicitedOptions[field.name] = resolved.value;
          continue;
        }

        const answer = await renderOptionPrompt(field, resolved);
        if (answer !== undefined && answer !== "") {
          elicitedOptions[field.name] = answer;
        }
      }
    }
  }

  return { elicitedOptions };
}
