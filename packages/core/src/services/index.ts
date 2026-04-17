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

// CloudControl factory — Story 50-4 Wave 5 Pass G
// (AwsConfig type is exported from cloudcontrol-client.ts directly;
// not re-exported through this barrel to avoid clash with the
// destroy-strategies AwsConfig of identical shape.)
export { createCloudControlClient } from "./cloudcontrol-client.js";

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
