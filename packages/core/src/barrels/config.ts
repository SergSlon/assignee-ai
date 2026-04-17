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
} from "../config/cfn-keys.js";

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
} from "../config/marker-tokens.js";

// Config — placeholder passwords for preflight rejection
export {
  RDS_PLACEHOLDER_PASSWORD,
  PLACEHOLDER_DB_PASSWORDS,
  RDS_PASSWORD_FIELDS,
} from "../config/placeholder-passwords.js";

// Config — ARN-to-CloudFormation type mapping
export {
  SERVICE_TYPE_MAP,
  SERVICE_SUBTYPE_MAP,
  arnToCloudFormationType,
} from "../config/arn-type-map.js";

export {
  buildResourceArn,
  partitionForRegion,
  isArn,
  type BuildResourceArnArgs,
} from "../config/arn-builder.js";

// Config — partition-aware region/ARN helpers (P0-2: GovCloud/China/ISO/ISOB)
export {
  getPartitionFromRegion,
  ARN_PATTERN,
  ARN_PATTERN_SOURCE,
  isArnOfService,
  type AwsPartition,
} from "../config/aws-partition.js";

// Config — structured AWS SDK error classifiers (Wave 4 F2)
export {
  isAccessDeniedError,
  isAuthFailureError,
  isThrottlingError,
} from "../config/aws-errors.js";

// Constants — AWS SDK error name strings (Story 50-4 Wave 5.1)
export { AwsErrorName } from "../constants/aws-error-names.js";

// Constants — Environment variable name registry (Story 50-4 Wave 5 Pass A)
export { EnvVar } from "../constants/env-vars.js";

// Constants — Instance category canonical values (Story 50-4 Wave 5 Pass C)
export {
  InstanceCategory,
  type InstanceCategoryType,
} from "../constants/instance-categories.js";

// Constants — Field elicitation policy (Story 50-4 Wave 5 Pass C)
export {
  FieldPolicy,
  type FieldPolicyType,
  FieldSource,
  type FieldSourceType,
  InjectionSource,
} from "../constants/field-policy.js";

// Constants — Resource field name registry (Story 50-4 Wave 5 Pass C)
export { ResourceFieldName } from "../constants/resource-fields.js";

// Config constants — filesystem path + filename constants (Story 50-4 Wave 5 Pass C)
// NOTE: PROVISIONS_FILE is ALSO exported from `list-resources/provision-log.ts`
//   (pre-existing single source of truth). We intentionally re-export the
//   copy from `paths.ts` — they resolve to the same string ("provisions.json").
//   `FAILURES_FILE` lives only here.
export {
  CHECKPOINT_DIR,
  BASELINES_DIR,
  FileName,
  FAILURES_FILE,
  CHECKPOINT_FILE_PREFIX,
} from "../config/constants/paths.js";

// Config constants — named enums (Promise/Cleanup/Pricing/LogSource/sentinels)
// (Story 50-4 Wave 5 Pass C)
export {
  CleanupCategoryName,
  PricingCategory,
  LogSource,
  PromiseStatus,
  WIZARD_NONE_SENTINEL,
} from "../config/constants/enums.js";

// Config constants — user-facing UI strings (Story 50-4 Wave 5 Pass C)
export {
  UserMessage,
  BoxenAlign,
  BoxenBorderColor,
  PLAN_GENERATION_FAILED,
  EXAMPLE_S3_INTENT,
} from "../config/constants/ui.js";

// Config constants — SaaS/Bedrock model IDs (Story 50-4 Wave 5 Pass C)
export { BEDROCK_MODEL_ID, SAAS_API_URL } from "../config/constants/saas.js";

// Config constants — prototype-pollution key denylist (Story 50-4 Wave 5 Pass C-2)
export { PROTO_POLLUTION_KEYS } from "../config/constants/security.js";

// Config constants — timeouts / polling caps / retry intervals (Story 50-4 Wave 5 Pass C-2)
export {
  DESTROY_MAX_POLL_ATTEMPTS,
  DESTROY_POLL_INTERVAL_MS,
  PRICING_TIMEOUT_MS,
  SECURITY_CHECK_TIMEOUT_MS,
  STS_TIMEOUT_MS,
  TWENTY_FOUR_HOURS_MS,
  PRICING_LOOKUP_TIMEOUT_MS,
  ORG_POLICY_FETCH_TIMEOUT_MS,
  MCP_SHUTDOWN_DELAY_MS,
  DRIFT_MAX_RETRIES,
  DRIFT_RETRY_BASE_DELAY_MS,
  DRIFT_RETRY_JITTER_MS,
  CLEANUP_SKIP_RECENT_MINUTES,
  CLEANUP_MAX_AGE_MS,
  MEMORY_DEDUP_THRESHOLD_MS,
  MAX_PROVISION_LOOPS,
  AUTO_CLEANUP_INTERVAL_MS,
  ORG_POLICY_TTL_MS,
} from "../config/constants/timeouts.js";

// Constants — AWS docs section titles (Story 50-4 Wave 5 Pass C)
export { DOC_SECTION_TITLES } from "../constants/doc-sections.js";

// Constants — Reconcile actions (Story 50-4 Wave 5 Pass C)
export {
  ReconcileAction,
  type ReconcileActionType,
} from "../constants/reconcile-actions.js";

// Constants — MCP server names (Story 50-4 Wave 5 Pass C)
export {
  McpServerName,
  McpCommand,
  type McpServerNameType,
} from "../constants/mcp.js";

// Constants — MCP tool name registry (Story 50-4 Wave 5 Pass C-2)
export { ToolName, type ToolNameType } from "../constants/tools.js";

// Constants — CLI command name registry (Story 50-4 Wave 5 Pass C-2)
export {
  CommandName,
  type CommandNameType,
  CommandDescription,
  CommandArgs,
  CommandOptions,
} from "../constants/commands.js";

// Constants — Process/Error/Content codes (Story 50-4 Wave 5 Pass C-2)
export {
  ProcessExitCode,
  ErrorCode,
  type ErrorCodeType,
  ContentType,
} from "../constants/errors.js";

// Constants — AWS Pricing API filters/terms (Story 50-4 Wave 5 Pass C-2)
// NOTE: `PricingServiceCode` already exported from `../barrels/pricing.js`.
export {
  PricingFilter,
  PricingTerm,
  PricingUnit,
  PricingScale,
  LambdaPricing,
} from "../constants/pricing-api.js";

// Config constants — AWS region/credential helpers (Story 50-4 Wave 5 Pass A)
export { AWS_REGION, CredentialError } from "../config/constants/aws.js";

// Config — operator credential reader (Story 50-4 Wave 5 Pass G)
export { operatorCredentials } from "../config/operator-credentials.js";

// Config — user config loader (Story 50-4 Wave 5 Pass G)
export {
  loadUserConfig,
  resolveConfigPath,
  validateUserConfig,
  type UserConfig,
} from "../config/user-config-loader.js";

// Config — org policy local loader (Story 50-4 Wave 5 Pass G)
export {
  loadLocalOrgPolicy,
  mergeOrgPolicies,
  findProjectPolicyPath,
  resolveUserPolicyPath,
} from "../config/org-policy-loader.js";

// Config — org policy SaaS-cached fetcher (Story 50-4 Wave 5 Pass G)
export { fetchOrgPolicy, readAuthToken } from "../config/org-policy-cache.js";

// Config — project-level config loader (Story 50-4 Wave 5 Pass G)
export { loadProjectConfig } from "../config/project-config-loader.js";

// Config constants — size limits / pricing-calc helpers (Story 50-4 Wave 5 Pass G)
export {
  SCHEMA_EXCERPT_MAX_CHARS,
  CHECKPOINT_DEFAULT_TTL_HOURS,
  MEMORY_MAX_PROVISIONS,
  MEMORY_MAX_FAILURES,
  MEMORY_MAX_PATTERNS,
  HOURS_PER_MONTH,
} from "../config/constants/limits.js";

// Config — shared ARN parsing helpers (Wave 3 P2-2 dedup).
// NOTE: `isArn` is ALSO exported from `./config/arn-builder.js` above for
// backward compatibility — both exports resolve to the same implementation.
export {
  arnToResourceType,
  extractIdentifierFromArn,
  extractRegionFromArn,
  extractAccountIdFromArn,
  getCloudControlIdentifier,
  ARN_IDENTIFIED_RESOURCE_TYPES,
} from "../config/arn-helpers.js";

// Config — AssigneeConfig schema and validation (Story 27.1)
export type {
  AssigneeConfig,
  ConfigDefaults,
  ConfigPreferences,
  ConfigBudget,
  ConfigNaming,
  AutoFixModeType,
} from "../config/index.js";
export {
  validateConfig,
  CONFIG_DEFAULTS,
  DEFAULT_AWS_REGION,
  AutoFixMode,
  resolveGlobalConfig,
  type GlobalConfigSources,
  type ResolvedGlobalConfig,
} from "../config/index.js";

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
} from "../config/resource-types.js";
export {
  RESOURCE_IDENTIFIER_KEYS,
  getPrimaryIdentifier,
} from "../config/resource-identifiers.js";
export { DiscoveryCacheKey } from "../config/discovery-keys.js";

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
} from "../config/aws-credentials.js";

// IAM — action map and policy generators
export { getRequiredIamActions } from "../config/iam-actions.js";
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
} from "../config/iam-policies.js";
export { IamEffect, type IamEffectType } from "../config/iam-effects.js";

// Resource Policy (config types for option elicitation — full loader in Story 7.2)
export type {
  OrgFieldPolicy,
  OrgFieldConfig,
  OrgResourceConfig,
  UserResourceConfig,
  ResolvedFieldConfig,
} from "../config/resource-policy.js";
export { OrgPolicy } from "../config/resource-policy.js";

// AWS ARNs — KMS/IAM managed policies, Bedrock, service principals
export {
  KMS_ALIAS_PREFIX,
  AwsManagedPolicy,
  awsManagedPolicyArn,
  BEDROCK_MODEL_ARN_WILDCARD,
  IamPolicy,
  IamAction,
  AwsServicePrincipal,
} from "../config/aws-arns.js";
