/** Field elicitation policy constants (Story 7.2 / 7.3). */

export const FieldPolicy = {
  NEVER_ASK: "never_ask",
  ASK_IF_NOT_SET: "ask_if_not_set",
  ALWAYS_ASK: "always_ask",
} as const;

export type FieldPolicyType = (typeof FieldPolicy)[keyof typeof FieldPolicy];

export const FieldSource = {
  PLUGIN_DEFAULT: "plugin_default",
  ORG_DEFAULT: "org_default",
  ORG_LOCKED: "org_locked",
  CLI_FLAG: "cli_flag",
  ENV_VAR: "env_var",
  USER_CONFIG: "user_config",
  PROJECT_CONFIG: "project_config",
} as const;

export type FieldSourceType = (typeof FieldSource)[keyof typeof FieldSource];

/**
 * Injection source identifiers for required-field repairer.
 * @see Story 42.10 — zero magic strings policy
 */
export const InjectionSource = {
  INITIAL_VALUE: "initialValue",
  PLUGIN_DEFAULT: "pluginDefault",
  INITIAL_VALUE_TO_CFN: "initialValue+toCfn",
} as const;
