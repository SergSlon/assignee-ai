/**
 * Config module barrel — re-exports config types and validation.
 * @see Story 27.1
 */
export type {
  AssigneeConfig,
  ConfigDefaults,
  ConfigPreferences,
  ConfigNaming,
} from "./config-schema.js";
export {
  validateConfig,
  CONFIG_DEFAULTS,
  DEFAULT_AWS_REGION,
} from "./config-schema.js";
