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
  StateField,
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
export {
  ASSIGNEE_DIR,
  CfnKey,
  type CfnKeyType,
  EIP_AUTO_ALLOCATE,
  ResourceDefault,
  AwsDefault,
  AssigneeTag,
  RdsEngineDisplay,
  CloudWatchStatistic,
  AmiOs,
  RdsEngineId,
  SizeLabel,
  RDS_ENGINE_VERSION_HINT,
  AWS_SERVICE_EXECUTE_API,
  UNKNOWN_FALLBACK,
  CACHE_DIR_NAME,
  WorkloadProfileKey,
} from "./config/cfn-keys.js";

// Config — marker tokens for compound-pattern cross-references (Story VPC-fix)
export {
  MARKER_PREFIX,
  MARKER_SUFFIX,
  MARKER_PATTERN,
  MARKER_PATTERN_GLOBAL,
  markerRef,
  markerGetAtt,
  markerAz,
  markerRegion,
  parseMarker,
  isMarker,
  type ParsedMarker,
} from "./config/marker-tokens.js";

// Config — placeholder passwords for preflight rejection
export {
  RDS_PLACEHOLDER_PASSWORD,
  PLACEHOLDER_DB_PASSWORDS,
  RDS_PASSWORD_FIELDS,
} from "./config/placeholder-passwords.js";

// Config — ARN-to-CloudFormation type mapping
export {
  SERVICE_TYPE_MAP,
  SERVICE_SUBTYPE_MAP,
  arnToCloudFormationType,
} from "./config/arn-type-map.js";

export {
  buildResourceArn,
  partitionForRegion,
  isArn,
  type BuildResourceArnArgs,
} from "./config/arn-builder.js";

// Config — partition-aware region/ARN helpers (P0-2: GovCloud/China/ISO/ISOB)
export {
  getPartitionFromRegion,
  ARN_PATTERN,
  ARN_PATTERN_SOURCE,
  isArnOfService,
  type AwsPartition,
} from "./config/aws-partition.js";

// Config — structured AWS SDK error classifiers (Wave 4 F2: replaces
// substring matching at 3 CLI sites + promotes the 5-code AccessDenied set
// from preflight to a shared helper; adds auth-failure and throttling
// classifiers so preflight can fail-closed on session errors).
export {
  isAccessDeniedError,
  isAuthFailureError,
  isThrottlingError,
} from "./config/aws-errors.js";

// Config — shared ARN parsing helpers (Wave 3 P2-2 dedup: CLI resource-resolver
// and MCP destroy-resource previously had divergent inline copies).
// NOTE: `isArn` is ALSO exported from `./config/arn-builder.js` above for
// backward compatibility — both exports resolve to the same implementation.
export {
  arnToResourceType,
  extractIdentifierFromArn,
  extractRegionFromArn,
  extractAccountIdFromArn,
  getCloudControlIdentifier,
  ARN_IDENTIFIED_RESOURCE_TYPES,
} from "./config/arn-helpers.js";

// Config — AssigneeConfig schema and validation (Story 27.1)
export type {
  AssigneeConfig,
  ConfigDefaults,
  ConfigPreferences,
  ConfigBudget,
  ConfigLlm,
  ConfigNaming,
  AutoFixModeType,
} from "./config/index.js";
export {
  validateConfig,
  CONFIG_DEFAULTS,
  DEFAULT_AWS_REGION,
  AutoFixMode,
  resolveGlobalConfig,
  type GlobalConfigSources,
  type ResolvedGlobalConfig,
} from "./config/index.js";

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
export { DiscoveryCacheKey } from "./config/discovery-keys.js";

// Config — centralized AWS credential resolution (Story 18.8 hardening)
export {
  requireAssigneeCredentials,
  tryAssigneeCredentials,
  hasAssigneeCredentials,
  availableRoles,
  envVarsForRole,
  ASSIGNEE_ROLES,
  MissingAssigneeCredentialsError,
  type AssigneeRole,
  type ExplicitAwsCredentials,
} from "./config/aws-credentials.js";

// IAM — action map and policy generators
export { getRequiredIamActions } from "./config/iam-actions.js";
export {
  operatorPolicy,
  operatorServicesAPolicy,
  operatorServicesBPolicy,
  readerPolicy,
  auditorPolicy,
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
  type PolicyDocument,
  type PolicyStatement,
} from "./config/iam-policies.js";
export { IamEffect, type IamEffectType } from "./config/iam-effects.js";

// Types
export { type Result, safeTry } from "./types/result.js";
export { PlanSchema, type Plan } from "./types/plan.js";

// Resource Plugins
export {
  defaultPluginRegistry,
  PluginRegistry,
  collectCompanionResources,
  lambdaRuntimes,
} from "./resource-plugins/index.js";

// Pattern Templates (Story 8.1)
export {
  defaultPatternRegistry,
  PatternRegistry,
  PatternId,
  // Item 1 (2026-04-09) + Item 3c (2026-04-10): patterns are exported
  // at the top-level barrel so the CLI test-harness + smoke-trace
  // suites can import them by name instead of reaching into an
  // internal module path. Every first-class compound is listed here
  // so future matrix/smoke expansion doesn't need a re-export step.
  vpcNetworkingPattern,
  vpcPublicOnlyPattern,
  staticWebsitePattern,
  lambdaWithExecRolePattern,
  efsWithVpcPattern,
  scheduledLambdaPattern,
  serverlessApiPattern,
  messageProcessingPattern,
  containerServicePattern,
  threeTierWebPattern,
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
export { QuestionTypeName } from "./resource-plugins/types.js";
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
export { OrgPolicy } from "./config/resource-policy.js";

// Utils
export { sanitizeUserIntent, MAX_INTENT_LENGTH } from "./utils/sanitize.js";

// Pricing Strategy Registry
export {
  defaultPricingRegistry,
  defaultDecomposerRegistry,
  PricingStrategyRegistry,
  PricingDecomposerRegistry,
  extractFirstTierPrice,
  formatLabelWithSource,
} from "./pricing/index.js";
export type {
  PricingStrategy,
  PricingEstimate,
  DataSource,
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
export {
  PricingMatchType,
  PricingField,
  PricingKind,
  PricingServiceCode,
  PricingProductFamily,
  CostEstimateLabel,
  FREE_TIER_MESSAGE,
  PricingFilterValue,
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
export type { LlmPort, LlmCallOptions } from "./ports/llm-port.js";
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

export {
  KMS_ALIAS_PREFIX,
  AwsManagedPolicy,
  awsManagedPolicyArn,
  BEDROCK_MODEL_ARN_WILDCARD,
  IamPolicy,
  IamAction,
  AwsServicePrincipal,
} from "./config/aws-arns.js";
