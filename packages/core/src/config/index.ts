/**
 * Config module barrel — re-exports config types and validation.
 * @see Story 27.1
 */
export type {
  AssigneeConfig,
  ConfigDefaults,
  ConfigPreferences,
  ConfigBudget,
  ConfigNaming,
  AutoFixModeType,
} from "./config-schema.js";
export {
  validateConfig,
  CONFIG_DEFAULTS,
  DEFAULT_AWS_REGION,
  AutoFixMode,
} from "./config-schema.js";

// A2 (2026-04-08) — global config precedence merger.
export {
  resolveGlobalConfig,
  type GlobalConfigSources,
  type ResolvedGlobalConfig,
} from "./resolve-global-config.js";
