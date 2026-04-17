/**
 * Structured JSON logger — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core`
 * (lifted in Story 50-4 Wave 5 Pass A so the in-core LlmAdapter and
 * token-usage accumulator can emit structured log events without
 * reaching back into the CLI app).
 *
 * Preserves feedback_token_cost_visibility: TOKEN_USAGE_SUMMARY stays
 * on the persist-info allowlist so per-command token cost is greppable
 * from disk.
 */
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
} from "@assignee/core";
