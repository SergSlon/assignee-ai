// Utils
export { sanitizeUserIntent, MAX_INTENT_LENGTH } from "../utils/sanitize.js";
export {
  redactSensitive,
  redactAccountIdsInPrompt,
  stripSensitiveFromElicited,
  buildSensitiveFieldSet,
  ELICITED_REDACTED_VALUE,
} from "../utils/redact.js";
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
  getFreeTierNoteWithConfig,
  getFreeTierMaps,
  getFreeTierCostLabel,
  type FreeTierTypeValue,
  type FreeTierNote,
  type FreeTierMaps,
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
  MINIMUM_LOG_RETENTION_DAYS,
  DEFAULT_AUDIT_RETENTION_DAYS,
  MINIMUM_AUDIT_RETENTION_DAYS,
  LOG_PRUNE_MARKER,
  resolveLogRetentionDays,
  resolveAuditRetentionDays,
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

// Telemetry — OTEL source-side allowlist + field classification (W6-04)
export {
  filterAllowlistedFields,
  isPiiIncluded,
  OTEL_FIELD_ALLOWLIST,
  ALLOWED_FIELD_NAMES,
  FIELD_PRIVACY_MAP,
  type AllowlistEntry,
  type PrivacyClass,
} from "../telemetry/otel-allowlist.js";

// Telemetry — Per-graph-node span emitter (W6-04)
export {
  emitNodeEntry,
  emitNodeExit,
  withNodeSpan,
  SPAN_EXCLUDED_NODES,
  type SpanEvent,
} from "../telemetry/spans.js";

// Utils — Display output (non-interactive renderers: spinner, intro/outro,
// success/error, compound, security, table, status) (Story 50-4 Wave 5 Pass C-2)
export {
  startSpinner,
  updateSpinner,
  stopSpinner,
  renderIntro,
  renderOutro,
  renderError,
  renderApplySuccess,
  renderCompoundSuccess,
  renderCompoundPartialFailure,
  renderSecurityWarnings,
  renderDependencyPlan,
  renderResourceTable,
  renderEmptyList,
  renderStatusSummary,
  renderEmptyStatus,
} from "../utils/display-output/index.js";
export type { StatusData } from "../utils/display-output/status-summary.js";

// Utils — Display helpers (label/value formatting + render state types) (Story 50-4 Wave 5 Pass C-2)
export type {
  RenderableState,
  RenderableCompoundQueue,
} from "../utils/display-helpers/index.js";
export {
  FRIENDLY_NAMES,
  FRIENDLY_NAMES_BY_TYPE,
  SENSITIVE_FIELDS,
  resolveFieldLabel,
  resolveSetKey,
  spacePascalCase,
  formatValue,
  formatSpecialValue,
  formatDesiredState,
} from "../utils/display-helpers/index.js";

// Utils — Display-plan, findings, docs renderers (Story 50-4 Wave 5 Pass C-2)
export {
  renderPlanBox,
  formatCostLine,
  formatPricingBreakdown,
  formatAppliedFixes,
  formatFixValue,
  formatAutoFixHint,
  regionLabel,
  // Epic 92 Wave 2.c — JSON envelope helpers (A-02 / D-29 / D-30)
  parsePlanJsonStream,
  serializePlanEnvelope,
  serializeErrorEnvelope,
  type JsonErrorEnvelope,
  type JsonErrorDetail,
  type JsonSuccessEnvelope,
} from "../utils/display-plan.js";
export {
  formatFindings,
  formatFreeTierNote,
  formatMemoryHints,
  formatAdviceHints,
} from "../utils/display-findings.js";
export {
  renderDocHelp,
  renderTradeoffHelp,
  fetchDocText,
  synthesizeDocHint,
} from "../utils/display-docs.js";

// Utils — Display prompts (interactive wizard) (Story 50-4 Wave 5 Pass C-2)
export {
  BACK_SENTINEL,
  HELP_SENTINEL,
  OTHER_SENTINEL,
  SKIP_SENTINEL,
  ENTER_VALUE_SENTINEL,
  REVIEW_SENTINEL,
  runReviewAnswers,
  renderHitlConfirm,
  renderHitlCompoundConfirm,
  renderAdvancedConfirm,
  renderApplyNowConfirm,
  renderOptionPrompt,
} from "../utils/display-prompts/index.js";

// Utils — ARN resolver (STS-backed account ID lookup + buildResourceArn wrapper) (Story 50-4 Wave 5 Pass C-2)
export {
  getOperatorAccountId,
  getOperatorCallerArn,
  resetAccountIdCache,
  resolveResourceArn,
} from "../utils/resolve-arn.js";

// NOTE: wizard-helpers + field-resolver stayed in CLI for this pass —
// their tests rely on vi.mock paths rooted under apps/cli. Re-lift is
// planned alongside Pass D (13-node lift) so nodes + tests move in the
// same wave.

// Utils — Pricing-lookup fetchers (EC2/RDS/Lambda/CW-Logs) (Story 50-4 Wave 5 Pass C-2)
export {
  fetchEc2InstancePrices,
  fetchRdsInstancePrices,
  fetchLambdaArchPrices,
  fetchCwLogsStoragePrice,
} from "../utils/pricing-lookup.js";

// Utils — Fix command resolver + selection (Story 50-4 Wave 5 Pass C-2)
export {
  FixCategory,
  type FixCategoryType,
  type FindingAction,
  resolveAction,
  countFixable,
  countAutoFixable,
} from "../utils/fix-command-resolver.js";
export {
  promptFixSelection,
  type FixSelectionResult,
  type FixSelectionState,
} from "../utils/fix-selection.js";

// Utils — Error message registry + catalogs + redaction (Story 50-4 Wave 5 Pass C-2)
export type {
  ErrorMessageEntry,
  ErrorResolveContext,
  FormattedError,
} from "../utils/error-messages/index.js";
export {
  ErrorMessageRegistry,
  defaultErrorMessageRegistry,
  formatErrorParts,
} from "../utils/error-messages/index.js";

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

// Utils — Memory recording helpers (Story 50-4 Wave 5 Pass H)
export {
  writeProvisionRecord,
  writeFailureRecord,
  clearFailureHistory,
  upsertPatternRecord,
  appendDestroyedArn,
} from "../utils/memory-recorder.js";

// Utils — Post-provision security posture check (Story 50-4 Wave 5 Pass H)
export { checkSecurityPosture } from "../utils/security-posture.js";

// Utils — ARN-structure-preserving redactor (W10-07 / P051 → L3-F16)
export {
  redactArn,
  redactArnsInString,
  REDACTED_ACCOUNT_ID,
  REDACTED_RESOURCE,
} from "../utils/arn-redactor.js";
