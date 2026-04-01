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
  BPEnforcementLevel,
  type BPEnforcementLevelType,
} from "./schema/graph-state.js";
export { AuditEventSchema, type AuditEvent } from "./schema/audit.js";
export {
  PlanCheckpointSchema,
  type PlanCheckpoint,
  CHECKPOINT_VERSION,
} from "./schema/checkpoint.js";
export {
  ProvisionRecordSchema,
  ProvisionLogSchema,
  FailureRecordSchema,
  FailureLogSchema,
  PatternRecordSchema,
  PatternLogSchema,
  type ProvisionRecord,
  type FailureRecord,
  type PatternRecord,
} from "./schema/memory.js";

// Drift detection types (Story 28.1)
export {
  DriftStatus,
  type DriftStatusType,
  ChangeType,
  type ChangeTypeValue,
  type DriftedField,
  type DriftResult,
  DriftedFieldSchema,
  DriftResultSchema,
  AUTO_POPULATED_FIELDS,
  isAutoPopulatedField,
} from "./schema/drift.js";

// Config — CloudFormation property key constants (Story 42.9)
export { CfnKey, type CfnKeyType } from "./config/cfn-keys.js";

// Config — AssigneeConfig schema and validation (Story 27.1)
export type {
  AssigneeConfig,
  ConfigDefaults,
  ConfigPreferences,
  ConfigNaming,
} from "./config/index.js";
export { validateConfig, CONFIG_DEFAULTS } from "./config/index.js";

// Config — resource type constants and identifier mappings
export {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
  LIST_RESOURCE_TYPES,
  type ResourceType,
  SUPPORTED_TYPES_ARRAY,
  SUPPORTED_POC_TYPES,
  CCAPI_FALLBACK_TYPES,
  type CcapiFallbackType,
  CCAPI_SDK_ROUTABLE_TYPES,
  CCAPI_REDIRECT_TYPES,
} from "./config/resource-types.js";
export {
  RESOURCE_IDENTIFIER_KEYS,
  getPrimaryIdentifier,
} from "./config/resource-identifiers.js";

// IAM — action map and policy generators
export { getRequiredIamActions } from "./config/iam-actions.js";
export {
  operatorPolicy,
  readerPolicy,
  auditorPolicy,
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
  type PolicyDocument,
  type PolicyStatement,
} from "./config/iam-policies.js";

// Types
export { type Result, safeTry } from "./types/result.js";
export { PlanSchema, type Plan } from "./types/plan.js";

// Resource Plugins
export {
  defaultPluginRegistry,
  PluginRegistry,
  collectCompanionResources,
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
  FetcherContext,
  QuestionType,
  ShowIfCondition,
  OptionMetadata,
  CfnOutput,
} from "./resource-plugins/types.js";
export type {
  CollectCompanionOptions,
  PlannedResource,
} from "./resource-plugins/companion-resources.js";

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
  defaultDecomposerRegistry,
  PricingStrategyRegistry,
  PricingDecomposerRegistry,
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
  PricingDecomposer,
  PricingLineItem,
  PricingLineItemKind,
  PricingLineItemResult,
  PricingBreakdown,
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
  CheckpointError,
  ProvisioningError,
  MissingRequiredFieldsError,
  UserCancelledError,
  PROVISIONING_ERROR_CODES,
  type ProvisioningErrorCode,
} from "./errors.js";
export {
  ErrorHintRegistry,
  defaultErrorHintRegistry,
} from "./errors/hint-registry.js";

// Ports (hexagonal architecture — Story 9.5)
export type { LlmPort } from "./ports/llm-port.js";
export { MockLlmAdapter } from "./ports/mock-llm-adapter.js";

// Services — CloudFormation schema fetching (Story 31.1, 31.2)
export {
  CloudFormationSchemaService,
  SchemaFetchError,
  type CloudFormationSchemaServiceConfig,
} from "./services/cloudformation-schema-service.js";
export {
  adaptDescribeTypeToMcpFormat,
  type AdaptedSchema,
} from "./services/schema-adapter.js";
export {
  SchemaCacheWarmer,
  type WarmResult,
  type WarmOptions,
} from "./services/schema-cache-warmer.js";
