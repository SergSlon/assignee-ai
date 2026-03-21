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
  ResourceResult,
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

// Utils
export { sanitizeUserIntent, MAX_INTENT_LENGTH } from "./utils/sanitize.js";

// Pricing Strategy Registry
export {
  defaultPricingRegistry,
  PricingStrategyRegistry,
  extractFirstTierPrice,
} from "./pricing/index.js";
export type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
  McpPricingFilter,
  AwsPricingResponse,
  AwsPricingItem,
  AwsPricingTerm,
  AwsPriceDimension,
} from "./pricing/index.js";

// Errors
export {
  AssigneeError,
  McpError,
  BedrockError,
  LlmError,
  StateGuardError,
  UnsupportedResourceError,
  ConfigurationError,
  ProvisioningError,
  type ProvisioningErrorCode,
} from "./errors.js";
export {
  ErrorHintRegistry,
  defaultErrorHintRegistry,
} from "./errors/hint-registry.js";

// Ports (hexagonal architecture — Story 9.5)
export type { LlmPort } from "./ports/llm-port.js";
export { MockLlmAdapter } from "./ports/mock-llm-adapter.js";
