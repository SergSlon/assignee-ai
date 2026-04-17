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
