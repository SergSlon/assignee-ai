/**
 * Policy types for resource option elicitation.
 * Consumed by option-elicitor (Story 7.3) and resolved by mergeConfigs (Story 7.2).
 */

/**
 * Policy directive for a single field from org admin configuration.
 * `locked`     = admin forces a value; user cannot override.
 * `default`    = admin suggests a value; user can override.
 * `always_ask` = admin forces the elicitor to always prompt.
 */
export type OrgFieldPolicy = "locked" | "default" | "always_ask";

export interface OrgFieldConfig {
  policy: OrgFieldPolicy;
  value?: unknown;
}

/**
 * Org-level resource option policy.
 * Keyed by CloudFormation resourceType → CloudFormation fieldName → policy config.
 */
export type OrgResourceConfig = Record<string, Record<string, OrgFieldConfig>>;

/**
 * User-level personal config preferences.
 * Keyed by resourceType → fieldName → preferred value.
 * Stored in ~/.config/assignee/config.yaml
 */
export type UserResourceConfig = Record<string, Record<string, unknown>>;

/**
 * The resolved output of mergeConfigs() for a single field.
 * Consumed by option-elicitor to decide whether/how to prompt.
 */
export interface ResolvedFieldConfig {
  /** Elicitation policy */
  policy: "always_ask" | "never_ask" | "ask_if_not_set";
  /** Pre-resolved value (set when policy is never_ask or ask_if_not_set with existing value) */
  value?: unknown;
  /** Where the resolved value came from (for debugging/logging) */
  source:
    | "cli_flag"
    | "env_var"
    | "user_config"
    | "org_default"
    | "org_locked"
    | "plugin_default";
}
