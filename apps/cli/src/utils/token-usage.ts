/**
 * Token usage accumulator — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core`
 * (lifted in Story 50-4 Wave 5 Pass A so the in-core LlmAdapter can
 * record per-callsite token usage without reaching back into the CLI
 * app).
 *
 * Preserves feedback_token_cost_visibility: every LlmAdapter call still
 * invokes `recordTokenUsage(callsite, usage, runId)` so per-command
 * token cost is greppable from `~/.assignee/logs/cli-*.jsonl`.
 */
export {
  normalizeTokenUsage,
  recordTokenUsage,
  getTokenUsageSummary,
  emitTokenUsageSummary,
  resetTokenUsage,
  type RawLlmUsage,
  type NormalizedTokenUsage,
  type TokenUsageSummary,
} from "@assignee/core";
