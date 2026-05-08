/**
 * Services barrel export.
 *
 * @see Story 31.1, Story 31.2
 */
export {
  CloudFormationSchemaService,
  SchemaFetchError,
  type CloudFormationSchemaServiceConfig,
} from "./cloudformation-schema-service.js";

export {
  adaptDescribeTypeToMcpFormat,
  type AdaptedSchema,
} from "./schema-adapter.js";

export {
  SchemaCacheWarmer,
  type WarmResult,
  type WarmOptions,
} from "./schema-cache-warmer.js";

export {
  getCachedPrice,
  setCachedPrice,
  sweepExpiredPrices,
  clearPriceCache,
} from "./price-cache.js";

// CloudControl + parallel service factories — Story 50-4 Wave 5 Pass G / W6-S2
// (AwsConfig type is exported from cloudcontrol-client.ts directly;
// not re-exported through this barrel to avoid clash with the
// destroy-strategies AwsConfig of identical shape.)
export {
  createCloudControlClient,
  createKmsClient,
  createSecretsManagerClient,
  createEventBridgeClient,
} from "./cloudcontrol-client.js";

// Advisory price enricher — Story 50-4 Wave 5 Pass G
export {
  enrichAdvisoryPrices,
  ENRICHABLE_PRICE_IDS,
} from "./advisory-price-enricher/index.js";

// Memory service — Story 50-4 Wave 5 Pass H
export { MemoryService, defaultMemoryService } from "./memory.js";

// S3 static-site upload — Story 50-4 Wave 5 Pass H
export {
  getMimeType,
  collectFiles,
  uploadStaticSite,
  configureBucketPolicy,
  type UploadResult,
  type UploadProgress,
} from "./s3-upload.js";

// Desired-state sanitizer — Story 50-4 Wave 5 Pass H
export {
  sanitizeDesiredState,
  type SanitizeResult,
} from "./desired-state-sanitizer.js";

// Required-field repairer — Story 50-4 Wave 5 Pass H
export {
  repairRequiredFields,
  type RepairResult,
} from "./required-field-repairer.js";

// KMS alias-based default CMK resolver — Wave C (epic-104-demo-dryrun)
export {
  resolveOrCreateDefaultKmsKey,
  clearKmsAliasCache,
  DEFAULT_KMS_ALIAS_NAME,
  type ResolveDefaultKmsKeyOptions,
  type ResolveDefaultKmsKeyResult,
} from "./kms-alias-resolver.js";
