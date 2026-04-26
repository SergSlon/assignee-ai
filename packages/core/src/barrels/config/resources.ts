// Config sub-barrel — resource-type wiring, ARN handling, config loaders,
// credential resolution, IAM policies, and resource-policy schemas. Split
// from `barrels/config.ts` per Story 56-it2-01 (L4-008).

// Config — ARN-to-CloudFormation type mapping
export {
  SERVICE_TYPE_MAP,
  SERVICE_SUBTYPE_MAP,
  arnToCloudFormationType,
} from "../../config/arn-type-map.js";

// Config — ARN builder / display synthesis
export {
  buildResourceArn,
  partitionForRegion,
  isArn,
  type BuildResourceArnArgs,
} from "../../config/arn-builder.js";

// Config — shared ARN parsing helpers (Wave 3 P2-2 dedup).
// NOTE: `isArn` is ALSO exported from `../../config/arn-builder.js` above for
// backward compatibility — both exports resolve to the same implementation.
export {
  arnToResourceType,
  extractIdentifierFromArn,
  extractRegionFromArn,
  extractAccountIdFromArn,
  getCloudControlIdentifier,
  ARN_IDENTIFIED_RESOURCE_TYPES,
} from "../../config/arn-helpers.js";

// Config — AWS SDK provider chain (W2-02 / P004 → L5-S05)
export {
  resolveOperatorCredentialProvider,
  type CredentialProvider,
} from "../../config/provider-chain.js";

// Config — user config loader (Story 50-4 Wave 5 Pass G)
export {
  loadUserConfig,
  resolveConfigPath,
  validateUserConfig,
  type UserConfig,
} from "../../config/user-config-loader.js";

// Config — org policy local loader (Story 50-4 Wave 5 Pass G)
export {
  loadLocalOrgPolicy,
  mergeOrgPolicies,
  findProjectPolicyPath,
  resolveUserPolicyPath,
} from "../../config/org-policy-loader.js";

// Config — org policy SaaS-cached fetcher (Story 50-4 Wave 5 Pass G)
export {
  fetchOrgPolicy,
  readAuthToken,
} from "../../config/org-policy-cache.js";

// Config — project-level config loader (Story 50-4 Wave 5 Pass G)
export { loadProjectConfig } from "../../config/project-config-loader.js";

// Config — AssigneeConfig schema and validation (Story 27.1)
export type {
  AssigneeConfig,
  ConfigDefaults,
  ConfigPreferences,
  ConfigBudget,
  ConfigNaming,
  AutoFixModeType,
} from "../../config/index.js";
export {
  validateConfig,
  CONFIG_DEFAULTS,
  DEFAULT_AWS_REGION,
  AutoFixMode,
  resolveGlobalConfig,
  type GlobalConfigSources,
  type ResolvedGlobalConfig,
} from "../../config/index.js";

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
} from "../../config/resource-types.js";
export {
  RESOURCE_IDENTIFIER_KEYS,
  getPrimaryIdentifier,
} from "../../config/resource-identifiers.js";
export { DiscoveryCacheKey } from "../../config/discovery-keys.js";

// Config — centralized AWS credential resolution (Story 18.8 hardening)
export {
  requireAssigneeCredentials,
  tryAssigneeCredentials,
  hasAssigneeCredentials,
  availableRoles,
  envVarsForRole,
  ASSIGNEE_ROLES,
  MissingAssigneeCredentialsError,
  InvalidSessionTokenError,
  type AssigneeRole,
  type ExplicitAwsCredentials,
} from "../../config/aws-credentials.js";

// IAM — action map and policy generators
export { getRequiredIamActions } from "../../config/iam-actions.js";
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
} from "../../config/iam-policies/index.js";

// Resource Policy (config types for option elicitation — full loader in Story 7.2)
export type {
  OrgFieldPolicy,
  OrgFieldConfig,
  OrgResourceConfig,
  UserResourceConfig,
  ResolvedFieldConfig,
} from "../../config/resource-policy.js";
export { OrgPolicy } from "../../config/resource-policy.js";
