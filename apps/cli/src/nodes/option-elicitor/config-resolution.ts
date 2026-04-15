/**
 * Config-aware field resolution with 6-level precedence.
 *
 * Story 27.4: user config + project config + org policy loaded in parallel,
 * then `mergeConfigs()` resolves field values per the precedence rules.
 * `never_ask` fields are injected silently; `ask_if_not_set` pre-fills
 * initialValue; `always_ask` forces a prompt regardless of config.
 *
 * Also handles `--set key=value` pre-fills (injected as NEVER_ASK) and
 * the "name-from-intent" regex match (e.g., "named foo-bar").
 *
 * Wave-6c F3: extracted from option-elicitor.ts (SRP).
 */

import {
  CfnKey,
  type ResourceField,
  type ResolvedFieldConfig,
} from "@assignee/core";
import { FieldPolicy, FieldSource } from "../../constants/field-policy.js";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import {
  mergeConfigs,
  type MergeConfigsInput,
} from "../../utils/merge-configs.js";
import { fieldFetchKey } from "../../utils/wizard-helpers.js";
import type { AgentState } from "../../services/graph.js";

export interface ResolvedFields {
  resolvedCommon: Record<string, ResolvedFieldConfig>;
  resolvedAdvanced: Record<string, ResolvedFieldConfig>;
}

export interface ConfigBundle {
  userConfig: unknown;
  projectConfig: unknown;
  orgPolicy: unknown;
}

export function resolveAllFields(params: {
  commonFields: ResourceField[];
  advancedFields: ResourceField[];
  state: AgentState;
  configs: ConfigBundle;
}): ResolvedFields {
  const { commonFields, advancedFields, state, configs } = params;
  const { userConfig, projectConfig, orgPolicy } = configs;

  const configDefaults: Record<string, unknown> = {};
  const resolvedConfig = (projectConfig ?? userConfig) as
    | { defaults?: { region?: string; tags?: unknown } }
    | null
    | undefined;
  if (resolvedConfig?.defaults?.region) {
    configDefaults[CfnKey.REGION] = resolvedConfig.defaults.region;
  }
  if (resolvedConfig?.defaults?.tags) {
    configDefaults[CfnKey.TAGS] = resolvedConfig.defaults.tags;
  }

  const userConfigAsResource = userConfig
    ? {
        [state.resourceType]: {
          ...configDefaults,
          ...(
            userConfig as unknown as Record<string, Record<string, unknown>>
          )?.[state.resourceType],
        },
      }
    : undefined;

  const projectConfigAsResource = projectConfig
    ? {
        [state.resourceType]: {
          ...((projectConfig as { defaults?: { region?: string } })?.defaults
            ?.region
            ? {
                region: (projectConfig as { defaults: { region: string } })
                  .defaults.region,
              }
            : {}),
          ...((projectConfig as { defaults?: { tags?: unknown } })?.defaults
            ?.tags
            ? {
                Tags: (projectConfig as { defaults: { tags: unknown } })
                  .defaults.tags,
              }
            : {}),
          ...(
            projectConfig as unknown as Record<string, Record<string, unknown>>
          )?.[state.resourceType],
        },
      }
    : undefined;

  const resolveFieldsWithConfig = (fields: ResourceField[]) => {
    const mergeInput: MergeConfigsInput = {
      pluginFields: fields,
      resourceType: state.resourceType,
      orgPolicy: orgPolicy as MergeConfigsInput["orgPolicy"],
      userConfig: userConfigAsResource,
      projectConfig: projectConfigAsResource,
    };
    const raw = mergeConfigs(mergeInput);
    const result: Record<string, ResolvedFieldConfig> = {};
    for (const field of fields) {
      const key = fieldFetchKey(field);
      const resolved = raw[field.name];
      if (resolved) {
        result[key] = { ...resolved };
      }
    }
    return result;
  };

  const resolvedCommon = resolveFieldsWithConfig(commonFields);
  const resolvedAdvanced = resolveFieldsWithConfig(advancedFields);

  preFillFromIntentName(state.userIntent, commonFields, resolvedCommon);
  applyPresetFields(state.presetFields, resolvedCommon, resolvedAdvanced);
  logResolvedNonDefaults(state.runId, resolvedCommon);

  return { resolvedCommon, resolvedAdvanced };
}

/** Pre-fill the primary name field from user intent (e.g., "named poc"). */
function preFillFromIntentName(
  userIntent: string | undefined,
  commonFields: ResourceField[],
  resolvedCommon: Record<string, ResolvedFieldConfig>,
): void {
  if (!userIntent) return;
  const nameMatch = userIntent.match(/\bnamed?\s+([^\s,]+)/i);
  if (!nameMatch?.[1]) return;
  const nameField = commonFields[0];
  if (!nameField) return;
  const key = fieldFetchKey(nameField);
  if (resolvedCommon[key] && !resolvedCommon[key]!.value) {
    resolvedCommon[key] = {
      ...resolvedCommon[key]!,
      value: nameMatch[1],
      source: FieldSource.PLUGIN_DEFAULT,
    };
  }
}

/** --set key=value pre-fills: inject into resolved configs as NEVER_ASK. */
function applyPresetFields(
  presetFields: Record<string, string> | undefined,
  resolvedCommon: Record<string, ResolvedFieldConfig>,
  resolvedAdvanced: Record<string, ResolvedFieldConfig>,
): void {
  if (!presetFields) return;
  for (const [fieldName, value] of Object.entries(presetFields)) {
    const typed = value === "true" ? true : value === "false" ? false : value;
    if (resolvedCommon[fieldName]) {
      resolvedCommon[fieldName] = {
        policy: FieldPolicy.NEVER_ASK,
        value: typed,
        source: FieldSource.PLUGIN_DEFAULT,
      };
    }
    if (resolvedAdvanced[fieldName]) {
      resolvedAdvanced[fieldName] = {
        policy: FieldPolicy.NEVER_ASK,
        value: typed,
        source: FieldSource.PLUGIN_DEFAULT,
      };
    }
  }
}

function logResolvedNonDefaults(
  runId: string | undefined,
  resolvedCommon: Record<string, ResolvedFieldConfig>,
): void {
  if (!runId) return;
  for (const [fieldName, resolved] of Object.entries(resolvedCommon)) {
    if (resolved.source !== FieldSource.PLUGIN_DEFAULT) {
      log({
        ts: new Date().toISOString(),
        runId,
        level: "info",
        action: LOG_ACTIONS.CONFIG_LOADED,
        extras: {
          field: fieldName,
          value: resolved.value,
          source: resolved.source,
          policy: resolved.policy,
        },
      });
    }
  }
}
