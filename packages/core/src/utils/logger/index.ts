/**
 * Structured JSON logger for the Assignee.ai CLI.
 *
 * stderr carries operational logs as single-line JSON; stdout is reserved
 * for user-facing output (plan boxes, prompts). error/warn events are
 * ALWAYS persisted to a rotating daily file under ~/.assignee/logs/
 * cli-YYYY-MM-DD.jsonl (override with ASSIGNEE_LOG_DIR).
 *
 * Lifted from `apps/cli/src/utils/logger.ts` in Story 50-4 Wave 5
 * Pass A so the in-core LlmAdapter + token-usage accumulator can emit
 * structured log events without reaching back into the CLI app.
 *
 * Implementation decomposed across ./*:
 *   - actions.ts    — LOG_ACTIONS / LogAction / LogLevel / LogEvent
 *   - paths.ts      — log dir resolution + daily file + numbered rotation
 *   - retention.ts  — pruneOldLogs / autoPruneLogsIfDue
 *   - persist.ts    — verbose-gated stderr + persistent-info allowlist + log()
 *
 * Preserves feedback_token_cost_visibility: TOKEN_USAGE_SUMMARY stays on the
 * persist-info allowlist so per-command token cost is greppable from disk.
 */
export {
  LOG_ACTIONS,
  LogLevel,
  type LogAction,
  type LogLevelType,
  type LogEvent,
} from "./actions.js";
export {
  LOG_FILE_SIZE_LIMIT_BYTES,
  setLogFileSizeLimitForTests,
  resetLogFileSizeLimitForTests,
  clearEnsuredDirCacheForTests,
  getLogDir,
} from "./paths.js";
export {
  DEFAULT_LOG_RETENTION_DAYS,
  MINIMUM_LOG_RETENTION_DAYS,
  DEFAULT_AUDIT_RETENTION_DAYS,
  MINIMUM_AUDIT_RETENTION_DAYS,
  LOG_PRUNE_MARKER,
  resolveLogRetentionDays,
  resolveAuditRetentionDays,
  pruneOldLogs,
  autoPruneLogsIfDue,
  type PruneResult,
} from "./retention.js";
export { log } from "./persist.js";
