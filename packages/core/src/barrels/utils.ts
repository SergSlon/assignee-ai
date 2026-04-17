// Utils
export { sanitizeUserIntent, MAX_INTENT_LENGTH } from "../utils/sanitize.js";
export { redactSensitive } from "../utils/redact.js";

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
