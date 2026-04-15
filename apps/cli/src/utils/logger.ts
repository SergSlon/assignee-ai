/**
 * Structured JSON logger for the Assignee.ai CLI — Wave 6d F5 barrel.
 *
 * stderr carries operational logs as single-line JSON; stdout is reserved
 * for user-facing output (plan boxes, prompts). error/warn events are
 * ALWAYS persisted to a rotating daily file under ~/.assignee/logs/
 * cli-YYYY-MM-DD.jsonl (override with ASSIGNEE_LOG_DIR).
 *
 * Implementation decomposed across ./logger/*:
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
} from "./logger/actions.js";
export {
  LOG_FILE_SIZE_LIMIT_BYTES,
  setLogFileSizeLimitForTests,
  resetLogFileSizeLimitForTests,
  clearEnsuredDirCacheForTests,
  getLogDir,
} from "./logger/paths.js";
export {
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_PRUNE_MARKER,
  resolveLogRetentionDays,
  pruneOldLogs,
  autoPruneLogsIfDue,
  type PruneResult,
} from "./logger/retention.js";
export { log } from "./logger/persist.js";
