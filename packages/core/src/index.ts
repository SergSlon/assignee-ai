// Schemas
export {
  GraphStateSchema,
  type GraphState,
  ExecutionMode,
  type ExecutionModeType,
  ExecutionStatus,
  type ExecutionStatusType,
  PreflightMode,
  type PreflightModeType,
} from "./schema/graph-state.js";
export { AuditEventSchema, type AuditEvent } from "./schema/audit.js";

// Config — resource type constants and identifier mappings
export {
  RESOURCE_TYPES,
  type ResourceType,
  SUPPORTED_TYPES_ARRAY,
  SUPPORTED_POC_TYPES,
} from "./config/resource-types.js";
export {
  RESOURCE_IDENTIFIER_KEYS,
  getPrimaryIdentifier,
} from "./config/resource-identifiers.js";

// Types
export { type Result, safeTry } from "./types/result.js";
export { PlanSchema, type Plan } from "./types/plan.js";

// Resource Plugins
export {
  defaultPluginRegistry,
  PluginRegistry,
} from "./resource-plugins/index.js";

// Pattern Templates (Story 8.1)
export {
  defaultPatternRegistry,
  PatternRegistry,
} from "./pattern-templates/index.js";
export type {
  ArchitecturePattern,
  ResourceSpec,
} from "./pattern-templates/types.js";
export type {
  ResourcePlugin,
  ResourceField,
  FieldQuestion,
  QuestionType,
  ShowIfCondition,
} from "./resource-plugins/types.js";

// Resource Policy (config types for option elicitation — full loader in Story 7.2)
export type {
  OrgFieldPolicy,
  OrgFieldConfig,
  OrgResourceConfig,
  UserResourceConfig,
  ResolvedFieldConfig,
} from "./config/resource-policy.js";

// Errors
export {
  AssigneeError,
  McpError,
  BedrockError,
  StateGuardError,
  UnsupportedResourceError,
} from "./errors.js";
