/**
 * 5-level precedence resolver for resource field configuration.
 * Merges plugin defaults, org policy, and user config into a single resolved config
 * consumed by the option-elicitor (Story 7.3).
 *
 * Precedence (highest → lowest):
 *   1. CLI flag (stub — wired in 7.3)
 *   2. Env var (stub — wired in 7.3)
 *   3. User config (~/.config/assignee/config.yaml)
 *   4. Org policy (SaaS or cached)
 *   5. Plugin default (ResourceField.question.initialValue)
 *
 * Special cases:
 *   - `locked` org field → overrides everything, source = "org_locked"
 *   - `always_ask` org field → forces prompt regardless of user config
 *
 * @see Story 7.2 — AC: 3, 4, 5
 */

import type { ResourceField } from "@assignee/core";
import type {
  OrgResourceConfig,
  UserResourceConfig,
  ResolvedFieldConfig,
} from "@assignee/core";

/**
 * Resolve field config for all plugin fields by merging org policy and user preferences.
 *
 * @param pluginFields - Fields declared by the resource plugin
 * @param orgPolicy - Org-level policy from SaaS API or cache (may be undefined)
 * @param userConfig - User-level preferences from config.yaml (may be undefined)
 * @param resourceType - CloudFormation resource type, e.g. "AWS::S3::Bucket"
 * @returns Map of field name → resolved config
 */
export function mergeConfigs(
  pluginFields: ResourceField[],
  orgPolicy: OrgResourceConfig | undefined,
  userConfig: UserResourceConfig | undefined,
  resourceType: string,
): Record<string, ResolvedFieldConfig> {
  const result: Record<string, ResolvedFieldConfig> = {};
  const orgFields = orgPolicy?.[resourceType] ?? {};
  const userFields = userConfig?.[resourceType] ?? {};

  for (const field of pluginFields) {
    const { name } = field;
    const orgField = orgFields[name];

    // Level 1: org locked → never_ask, lock the value
    if (orgField?.policy === "locked") {
      result[name] = {
        policy: "never_ask",
        value: orgField.value,
        source: "org_locked",
      };
      continue;
    }

    // Level 2: org always_ask → force prompt regardless of user config
    if (orgField?.policy === "always_ask") {
      result[name] = { policy: "always_ask", source: "org_default" };
      continue;
    }

    // Level 3: user config has value → ask_if_not_set (respect it but still elicit if absent)
    if (name in userFields) {
      result[name] = {
        policy: "ask_if_not_set",
        value: userFields[name],
        source: "user_config",
      };
      continue;
    }

    // Level 4: org default → suggest value, ask_if_not_set
    if (orgField?.policy === "default" && orgField.value !== undefined) {
      result[name] = {
        policy: "ask_if_not_set",
        value: orgField.value,
        source: "org_default",
      };
      continue;
    }

    // Level 5: plugin default
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
