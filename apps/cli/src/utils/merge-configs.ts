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

import type { ResourceField } from "@assignee/core";
import type {
  OrgResourceConfig,
  UserResourceConfig,
  ResolvedFieldConfig,
} from "@assignee/core";

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
    if (orgField?.policy === "locked") {
      result[name] = {
        policy: "never_ask",
        value: orgField.value,
        source: "org_locked",
      };
      continue;
    }

    // Priority 0b: org always_ask → force prompt regardless of all config
    if (orgField?.policy === "always_ask") {
      result[name] = { policy: "always_ask", source: "org_default" };
      continue;
    }

    // Level 1: CLI flag
    if (name in cliFields && cliFields[name] !== undefined) {
      result[name] = {
        policy: "ask_if_not_set",
        value: cliFields[name],
        source: "cli_flag",
      };
      continue;
    }

    // Level 2: Env var override
    if (name in envFields && envFields[name] !== undefined) {
      result[name] = {
        policy: "ask_if_not_set",
        value: envFields[name],
        source: "env_var",
      };
      continue;
    }

    // Level 3: Project config (.assignee/config.yaml)
    if (name in projectFields && projectFields[name] !== undefined) {
      result[name] = {
        policy: "ask_if_not_set",
        value: projectFields[name],
        source: "project_config",
      };
      continue;
    }

    // Level 4: User config (~/.config/assignee/config.yaml)
    if (name in userFields && userFields[name] !== undefined) {
      result[name] = {
        policy: "ask_if_not_set",
        value: userFields[name],
        source: "user_config",
      };
      continue;
    }

    // Level 5: Org default
    if (orgField?.policy === "default" && orgField.value !== undefined) {
      result[name] = {
        policy: "ask_if_not_set",
        value: orgField.value,
        source: "org_default",
      };
      continue;
    }

    // Level 6: Plugin default
    const pluginDefault = field.question.initialValue;
    if (pluginDefault !== undefined) {
      result[name] = {
        policy: "ask_if_not_set",
        value: pluginDefault,
        source: "plugin_default",
      };
      continue;
    }

    // No default anywhere → always ask
    result[name] = { policy: "always_ask", source: "plugin_default" };
  }

  return result;
}
