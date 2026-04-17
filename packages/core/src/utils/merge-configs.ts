/**
 * 6-level precedence resolver for resource field configuration.
 * Merges plugin defaults, org policy, user config, project config,
 * env overrides, and CLI flags into a single resolved config
 * consumed by the option-elicitor (Story 7.3, upgraded in Story 27.2).
 *
 * Precedence (highest → lowest):
 *   0. Org locked (overrides EVERYTHING, including CLI flags)
 *   0. Org always_ask (forces prompt regardless of all config)
 *   1. CLI flags
 *   2. Env var overrides (ASSIGNEE_*)
 *   3. Project config (.assignee/config.yaml)
 *   4. User config (~/.config/assignee/config.yaml)
 *   5. Org default
 *   6. Plugin default (ResourceField.question.initialValue)
 *
 * @see Story 27.2 — 6-Level Precedence Resolver
 */

import {
  OrgPolicy,
  type OrgResourceConfig,
  type UserResourceConfig,
  type ResolvedFieldConfig,
} from "../config/resource-policy.js";
import type { ResourceField } from "../resource-plugins/types.js";
import { FieldPolicy, FieldSource } from "../constants/field-policy.js";

/**
 * Input options for the 6-level mergeConfigs resolver.
 * All parameters except pluginFields and resourceType are optional
 * for backward compatibility.
 */
export interface MergeConfigsInput {
  pluginFields: ResourceField[];
  resourceType: string;
  cliFlags?: Record<string, unknown>;
  envOverrides?: Record<string, unknown>;
  projectConfig?: UserResourceConfig;
  userConfig?: UserResourceConfig;
  orgPolicy?: OrgResourceConfig;
}

/**
 * Resolve field config for all plugin fields by merging 6 precedence levels.
 *
 * Overloaded for backward compatibility:
 * - New callers: pass a single MergeConfigsInput object.
 * - Legacy callers: pass (pluginFields, orgPolicy, userConfig, resourceType).
 */
export function mergeConfigs(
  pluginFieldsOrInput: ResourceField[] | MergeConfigsInput,
  orgPolicy?: OrgResourceConfig | undefined,
  userConfig?: UserResourceConfig | undefined,
  resourceType?: string,
): Record<string, ResolvedFieldConfig> {
  // Normalize: support both old 4-arg signature and new options object.
  let input: MergeConfigsInput;

  if (Array.isArray(pluginFieldsOrInput)) {
    // Legacy call signature
    input = {
      pluginFields: pluginFieldsOrInput,
      orgPolicy,
      userConfig,
      resourceType: resourceType!,
    };
  } else {
    input = pluginFieldsOrInput;
  }

  const result: Record<string, ResolvedFieldConfig> = {};
  const orgFields = input.orgPolicy?.[input.resourceType] ?? {};
  const userFields = input.userConfig?.[input.resourceType] ?? {};
  const projectFields = input.projectConfig?.[input.resourceType] ?? {};
  const envFields = input.envOverrides ?? {};
  const cliFields = input.cliFlags ?? {};

  for (const field of input.pluginFields) {
    const { name } = field;
    const orgField = orgFields[name];

    // Priority 0a: org locked → never_ask, overrides EVERYTHING including CLI flags
    if (orgField?.policy === OrgPolicy.LOCKED) {
      result[name] = {
        policy: FieldPolicy.NEVER_ASK,
        value: orgField.value,
        source: FieldSource.ORG_LOCKED,
      };
      continue;
    }

    // Priority 0b: org always_ask → force prompt regardless of all config
    if (orgField?.policy === OrgPolicy.ALWAYS_ASK) {
      result[name] = {
        policy: FieldPolicy.ALWAYS_ASK,
        source: FieldSource.ORG_DEFAULT,
      };
      continue;
    }

    // Level 1: CLI flag
    if (name in cliFields && cliFields[name] !== undefined) {
      result[name] = {
        policy: FieldPolicy.ASK_IF_NOT_SET,
        value: cliFields[name],
        source: FieldSource.CLI_FLAG,
      };
      continue;
    }

    // Level 2: Env var override
    if (name in envFields && envFields[name] !== undefined) {
      result[name] = {
        policy: FieldPolicy.ASK_IF_NOT_SET,
        value: envFields[name],
        source: FieldSource.ENV_VAR,
      };
      continue;
    }

    // Level 3: Project config (.assignee/config.yaml)
    if (name in projectFields && projectFields[name] !== undefined) {
      result[name] = {
        policy: FieldPolicy.ASK_IF_NOT_SET,
        value: projectFields[name],
        source: FieldSource.PROJECT_CONFIG,
      };
      continue;
    }

    // Level 4: User config (~/.config/assignee/config.yaml)
    if (name in userFields && userFields[name] !== undefined) {
      result[name] = {
        policy: FieldPolicy.ASK_IF_NOT_SET,
        value: userFields[name],
        source: FieldSource.USER_CONFIG,
      };
      continue;
    }

    // Level 5: Org default
    if (
      orgField?.policy === OrgPolicy.DEFAULT &&
      orgField.value !== undefined
    ) {
      result[name] = {
        policy: FieldPolicy.ASK_IF_NOT_SET,
        value: orgField.value,
        source: FieldSource.ORG_DEFAULT,
      };
      continue;
    }

    // Level 6: Plugin default
    const pluginDefault = field.question.initialValue;
    if (pluginDefault !== undefined) {
      result[name] = {
        policy: FieldPolicy.ASK_IF_NOT_SET,
        value: pluginDefault,
        source: FieldSource.PLUGIN_DEFAULT,
      };
      continue;
    }

    // No default anywhere → always ask
    result[name] = {
      policy: FieldPolicy.ALWAYS_ASK,
      source: FieldSource.PLUGIN_DEFAULT,
    };
  }

  return result;
}
