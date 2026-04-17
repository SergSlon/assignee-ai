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
