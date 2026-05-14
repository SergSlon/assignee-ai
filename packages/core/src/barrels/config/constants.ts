// Config sub-barrel — pure constants / enums / primitive classifiers.
// No AWS SDK side-effects, no config loaders. Split from `barrels/config.ts`
// per Story 56-it2-01 (L4-008). Keep this file ≤ 200 LOC.

// CloudFormation property-key constants (Story 42.9)
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
} from "../../config/cfn-keys.js";

// Marker tokens for compound-pattern cross-references (Story VPC-fix)
export {
  MARKER_PREFIX,
  MARKER_SUFFIX,
  MARKER_PATTERN,
  MARKER_PATTERN_GLOBAL,
  markerRef,
  markerGetAtt,
  markerIdentifier,
  markerAz,
  markerRegion,
  markerAccountId,
  parseMarker,
  isMarker,
  type ParsedMarker,
} from "../../config/marker-tokens.js";

// Placeholder passwords for preflight rejection
export {
  RDS_PLACEHOLDER_PASSWORD,
  RDS_REQUIRED_PASSWORD_PLACEHOLDER,
  PLACEHOLDER_DB_PASSWORDS,
  RDS_PASSWORD_FIELDS,
} from "../../config/placeholder-passwords.js";

// Partition-aware region/ARN helpers (P0-2: GovCloud/China/ISO/ISOB)
export {
  getPartitionFromRegion,
  ARN_PATTERN,
  ARN_PATTERN_SOURCE,
  isArnOfService,
  type AwsPartition,
} from "../../config/aws-partition.js";

// Structured AWS SDK error classifiers (Wave 4 F2) + error-name registry
export {
  isAccessDeniedError,
  isAuthFailureError,
  isThrottlingError,
} from "../../config/aws-errors.js";
export { AwsErrorName } from "../../constants/aws-error-names.js";

// Env-var + graph-node registries, plus instance/field policy + resource fields
export { EnvVar } from "../../constants/env-vars.js";
export { GraphNode, type GraphNodeType } from "../../constants/graph-node.js";
export {
  InstanceCategory,
  type InstanceCategoryType,
} from "../../constants/instance-categories.js";
export {
  FieldPolicy,
  type FieldPolicyType,
  FieldSource,
  type FieldSourceType,
  InjectionSource,
} from "../../constants/field-policy.js";
export { ResourceFieldName } from "../../constants/resource-fields.js";

// Filesystem path + filename constants.
export {
  CHECKPOINT_DIR,
  BASELINES_DIR,
  FileName,
  CHECKPOINT_FILE_PREFIX,
} from "../../config/constants/paths.js";

// Named enums (Promise/Cleanup/Pricing/LogSource/sentinels)
export {
  CleanupCategoryName,
  PricingCategory,
  LogSource,
  PromiseStatus,
  WIZARD_NONE_SENTINEL,
} from "../../config/constants/enums.js";

// User-facing UI strings
export {
  UserMessage,
  BoxenAlign,
  BoxenBorderColor,
  PLAN_GENERATION_FAILED,
  EXAMPLE_S3_INTENT,
} from "../../config/constants/ui.js";

// SaaS/Bedrock model IDs, proto-pollution denylist, and timeouts / retries
export { BEDROCK_MODEL_ID, SAAS_API_URL } from "../../config/constants/saas.js";
export { PROTO_POLLUTION_KEYS } from "../../config/constants/security.js";
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
} from "../../config/constants/timeouts.js";

// AWS docs sections + reconcile actions + MCP server/tool/command registries
export { DOC_SECTION_TITLES } from "../../constants/doc-sections.js";
export {
  ReconcileAction,
  type ReconcileActionType,
} from "../../constants/reconcile-actions.js";
export {
  McpServerName,
  McpCommand,
  type McpServerNameType,
} from "../../constants/mcp.js";
export { ToolName, type ToolNameType } from "../../constants/tools.js";
export {
  CommandName,
  type CommandNameType,
  CommandDescription,
  CommandArgs,
  CommandOptions,
} from "../../constants/commands.js";

// Process/Error/Content codes + AWS Pricing API filters/terms.
// NOTE: `PricingServiceCode` is exported from `../pricing.js`.
export {
  ProcessExitCode,
  ErrorCode,
  type ErrorCodeType,
  ContentType,
} from "../../constants/errors.js";
export {
  PricingFilter,
  PricingTerm,
  PricingUnit,
  PricingScale,
  LambdaPricing,
} from "../../constants/pricing-api.js";

// AWS region/credential helpers (Story 50-4 Wave 5 Pass A)
export { AWS_REGION, CredentialError } from "../../config/constants/aws.js";

// Size limits / pricing-calc helpers (Story 50-4 Wave 5 Pass G)
export {
  SCHEMA_EXCERPT_MAX_CHARS,
  CHECKPOINT_DEFAULT_TTL_HOURS,
  MEMORY_MAX_PROVISIONS,
  MEMORY_MAX_FAILURES,
  MEMORY_MAX_PATTERNS,
  HOURS_PER_MONTH,
} from "../../config/constants/limits.js";

// AWS ARNs — KMS/IAM managed policies, Bedrock, service principals
export {
  KMS_ALIAS_PREFIX,
  AwsManagedPolicy,
  awsManagedPolicyArn,
  BEDROCK_MODEL_ARN_WILDCARD,
  IamPolicy,
  IamAction,
  AwsServicePrincipal,
} from "../../config/aws-arns.js";

// CloudFormation keys (Story 50-4 Wave 5 Pass H) + IAM effect enum
export {
  CloudFormationKey,
  CFN_RESOURCE_TYPE_PREFIX,
} from "../../constants/cfn-keys.js";
export { IamEffect, type IamEffectType } from "../../config/iam-effects.js";
