// Utils
export { sanitizeUserIntent, MAX_INTENT_LENGTH } from "../utils/sanitize.js";
export { redactSensitive } from "../utils/redact.js";
export { withTimeout } from "../utils/timeout.js";
export { unwrapMcpText } from "../utils/mcp.js";
export {
  wizardKeyMap,
  toSetFlag,
  toSetFlagFromPatch,
} from "../utils/wizard-key-map.js";
export {
  injectMandatoryTags,
  TAG_KEY_MANAGED_BY,
  TAG_VALUE_MANAGED_BY,
  type CfnTag,
} from "../utils/tags.js";
export type {
  IntentDefaultOverride,
  IntentRule,
} from "../utils/intent-defaults/index.js";
export {
  INTENT_RULES,
  getIntentDefaults,
  applyIntentOverrides,
} from "../utils/intent-defaults/index.js";
export {
  classifyWorkload,
  _clearClassificationCache,
  WorkloadProfileSchema,
  type WorkloadProfile,
  type WorkloadClassification,
} from "../utils/workload-classifier.js";
export {
  mergeConfigs,
  type MergeConfigsInput,
} from "../utils/merge-configs.js";
export {
  validateCoherence,
  type CoherenceWarning,
} from "../utils/coherence-validator.js";
export {
  RECOMMENDATION_RULES,
  evaluateWizardRecommendations,
  displayRecommendations,
  type RecommendationSeverity,
  type RecommendationRule,
  type WizardRecommendation,
} from "../utils/wizard-recommendations.js";
export {
  rankOptions,
  PROFILE_KEYWORDS,
  RECOMMENDED_BONUS,
  KEYWORD_MATCH_SCORE,
  type RankedResult,
} from "../utils/option-ranker.js";
export { enrichOptionLabel } from "../utils/option-enrichment.js";
export {
  isMcpSearchResponse,
  extractFirstUrl,
  type McpSearchResult,
  type McpSearchResponse,
} from "../utils/mcp-types.js";
export {
  FreeTierType,
  loadAccountCreatedDate,
  _resetAccountDateCache,
  getFreeTierNote,
  getFreeTierCostLabel,
  type FreeTierTypeValue,
  type FreeTierNote,
} from "../utils/free-tier.js";
export type {
  DiscoveryOption,
  InstanceTypeCategory,
} from "../utils/aws-resource-discovery/index.js";
export {
  clearDiscoveryCache,
  discoverInstanceTypes,
  discoverAmis,
  resolveAmiFromOsName,
  searchAmis,
  discoverSubnets,
  discoverSecurityGroups,
  discoverKeyPairs,
  discoverRdsEngineVersions,
  discoverRdsInstanceClasses,
  discoverLambdaRuntimes,
} from "../utils/aws-resource-discovery/index.js";

// Utils — Structured JSON logger (Story 50-4 Wave 5 Pass A)
export {
  LOG_ACTIONS,
  LogLevel,
  LOG_FILE_SIZE_LIMIT_BYTES,
  setLogFileSizeLimitForTests,
  resetLogFileSizeLimitForTests,
  clearEnsuredDirCacheForTests,
  getLogDir,
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_PRUNE_MARKER,
  resolveLogRetentionDays,
  pruneOldLogs,
  autoPruneLogsIfDue,
  log,
  type LogAction,
  type LogLevelType,
  type LogEvent,
  type PruneResult,
} from "../utils/logger/index.js";

// Utils — Token usage accumulator (Story 50-4 Wave 5 Pass A)
export {
  normalizeTokenUsage,
  recordTokenUsage,
  getTokenUsageSummary,
  emitTokenUsageSummary,
  resetTokenUsage,
  type RawLlmUsage,
  type NormalizedTokenUsage,
  type TokenUsageSummary,
} from "../utils/token-usage.js";

// Telemetry — OTLP/HTTP-JSON log exporter (Story 50-4 Wave 5 Pass A)
export {
  DEFAULT_OTEL_SERVICE_NAME,
  OTLP_LOGS_PATH,
  OTEL_EXPORT_TIMEOUT_MS,
  getOtelEndpoint,
  getOtelServiceName,
  isOtelEnabled,
  buildOtlpPayload,
  exportLogEvent,
  type OtlpLogPayload,
} from "../telemetry/otel-exporter.js";

// Utils — Recording interceptor for external-API fixture capture (Story 50-4 Wave 5 Pass A)
export type {
  McpRecordedCall,
  SdkRecordedCall,
  LlmRecordedCall,
  RecordedCall,
  RecordingManifest,
} from "../utils/recorder/index.js";
export {
  redactStringValue,
  sanitizeFilenameSegment,
  getRecordingDir,
  RecordingInterceptor,
  isRecordingEnabled,
  wrapToolWithRecorder,
  addRecordingMiddleware,
  RecordingLlmAdapter,
} from "../utils/recorder/index.js";
