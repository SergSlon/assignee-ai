// Ports (hexagonal architecture — Story 9.5)
export type { LlmPort, LlmCallOptions } from "../ports/llm-port.js";
// NOTE: MockLlmAdapter moved to `@assignee/core/testing` sub-path export
// (Story 50-4) so production code never pulls in test doubles.

// ConfigPort — abstraction over env-var / configuration lookup (MASTER-009).
// Eliminates direct `process.env` reads scattered through core so
// multi-tenant SaaS can inject tenant-scoped configuration adapters.
// Default `ProcessEnvConfigAdapter` reads from `process.env`; SaaS
// callers supply their own adapter at the composition root. NO module-
// level singleton — every consumer takes a `ConfigPort` via DI.
export {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";

// LLM provider identifiers (Story 50-4 Wave 5.1).
// Concrete LlmAdapter remains in apps/cli pending future-wave lifts of
// the dep closure (AWS_REGION, EnvVar, recordTokenUsage, logger). Apps
// that need to construct an LlmPort instance still reach into the CLI.
export {
  LlmProvider,
  type LlmProviderType,
} from "../constants/llm-providers.js";

// ProvisioningPort — abstracts CloudControl SDK operations (Story 50-4 Wave 5.1)
export {
  ProvisioningErrorKind,
  type ProvisioningErrorKindType,
  type ProvisioningPort,
  type ProvisioningPortError,
  type CreateResourceResult,
  type DeleteResourceResult,
  type UpdateResourceResult,
  type GetRequestStatusResult,
} from "../ports/provisioning-port.js";

// CheckpointerPort — hexagonal port for LangGraph HITL checkpoint adapters
// (W4-01, MASTER-010 consolidation). Concrete adapters live in
// `../checkpoint/` (in-memory + file-durable).
export type { CheckpointerPort } from "../ports/checkpoint-port.js";

// OIDCPort — identity verification port (W3-03, MASTER-010 consolidation).
// Concrete in-memory adapter lives in `../identity/`.
export type { Claims, OIDCPort } from "../ports/oidc-port.js";

// AdvisoryLockPort — file/distributed advisory locking port (W4-03,
// MASTER-010 consolidation). Concrete file adapter lives in `../locks/`.
export type { AdvisoryLockPort } from "../ports/advisory-lock-port.js";

// TelemetryPort — observability emission port (W4-05, MASTER-010
// consolidation). Concrete in-memory adapter lives in `../telemetry/`.
export {
  isTelemetryEnabled,
  emitFiltered,
  type TelemetryPort,
} from "../ports/telemetry-port.js";

// StoragePort — key/value blob storage port (RW4d, MASTER-016).
// Default LocalFsStorageAdapter mirrors today's filesystem-based
// persistence (atomic writes, mode 0600/0700, path-traversal hardening
// at the port boundary). Migration of existing fs call-sites
// (checkpoint store, RBAC policy-store, file advisory lock,
// user-config-loader, etc.) deferred to RW4d-migration.
export type { StoragePort } from "../ports/storage-port.js";
export {
  LocalFsStorageAdapter,
  type LocalFsStorageAdapterOptions,
} from "../adapters/storage/local-fs-adapter.js";

// Services — CloudFormation schema fetching (Story 31.1, 31.2)
export {
  CloudFormationSchemaService,
  SchemaFetchError,
  type CloudFormationSchemaServiceConfig,
} from "../services/cloudformation-schema-service.js";
export {
  adaptDescribeTypeToMcpFormat,
  type AdaptedSchema,
} from "../services/schema-adapter.js";
export {
  SchemaCacheWarmer,
  type WarmResult,
  type WarmOptions,
} from "../services/schema-cache-warmer.js";

// Services — persistent price cache (Story 50-4 Wave 5 Pass C-2)
export {
  getCachedPrice,
  setCachedPrice,
  sweepExpiredPrices,
  clearPriceCache,
} from "../services/price-cache.js";

// Services — CloudControl client factory (Story 50-4 Wave 5 Pass G).
// NOTE: `AwsConfig` is intentionally NOT re-exported here — the
// destroy-strategies barrel already exports an identically-shaped
// `AwsConfig` (Story 49.1). Consumers that need the type should
// import it from the destroy-strategies barrel or use the structural
// shape directly.
export {
  createCloudControlClient,
  createKmsClient,
  createSecretsManagerClient,
  createEventBridgeClient,
} from "../services/cloudcontrol-client.js";

// Services — advisory price enricher (Story 50-4 Wave 5 Pass G)
export {
  enrichAdvisoryPrices,
  ENRICHABLE_PRICE_IDS,
} from "../services/advisory-price-enricher/index.js";

// Services — memory (Story 50-4 Wave 5 Pass H)
export { MemoryService, defaultMemoryService } from "../services/memory.js";

// Services — S3 static-site upload (Story 50-4 Wave 5 Pass H)
export {
  getMimeType,
  collectFiles,
  uploadStaticSite,
  configureBucketPolicy,
  type UploadResult,
  type UploadProgress,
} from "../services/s3-upload.js";

// Services — CloudFront cache invalidation (`assignee dev update` follow-on)
export {
  createInvalidation,
  waitForInvalidation,
  MAX_INVALIDATION_PATHS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  type InvalidationArgs,
  type InvalidationResult,
} from "../services/cloudfront-invalidate.js";

// Services — desired-state sanitizer (Story 50-4 Wave 5 Pass H)
export {
  sanitizeDesiredState,
  type SanitizeResult,
} from "../services/desired-state-sanitizer.js";

// Services — required-field repairer (Story 50-4 Wave 5 Pass H)
export {
  repairRequiredFields,
  type RepairResult,
} from "../services/required-field-repairer.js";
