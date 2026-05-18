/**
 * Token usage accumulator for the LLM-calling nodes in the 13-node
 * LangGraph pipeline.
 *
 * Lifted from `apps/cli/src/utils/token-usage.ts` in Story 50-4
 * Wave 5 Pass A so LlmAdapter (in `@assignee/core/llm`) can record
 * per-callsite token usage without reaching back into the CLI app.
 *
 * Wave 12 P0: every assignee command makes one or more LLM calls
 * (intent_parser → classify, plan_generator → JSON, advice_generator →
 * hints, etc.). Without instrumentation we cannot answer:
 *   - which node is the token hog?
 *   - what does ONE `assignee infra plan` actually cost?
 *   - is the per-command cost stable across resource types or does
 *     compound-VPC blow up?
 * These questions gate the Phase 3 SaaS unit economics.
 *
 * Design:
 *   - LlmAdapter calls `recordTokenUsage(callsite, usage)` after every
 *     successful Vercel AI SDK call.
 *   - Each call is logged immediately as a structured TOKEN_USAGE event
 *     so users can `grep token_usage ~/.assignee/logs/cli-*.jsonl` and
 *     analyze without re-running.
 *   - The accumulator keeps a per-callsite tally (and per-runId tally)
 *     in process-local memory; `getTokenUsageSummary(runId?)` returns
 *     the running totals so result-formatter can emit a TOKEN_USAGE_SUMMARY
 *     at end-of-command.
 *   - `resetTokenUsage()` clears state — used between unit tests AND
 *     at the start of each command (the CLI is typically one command
 *     per process, but reset is cheap and defensive).
 *
 * The accumulator is process-local. The CLI is single-command so no
 * locking is required. If a future wave introduces parallel command
 * execution within one process, this module needs a per-runId Map
 * isolation step (already prepared via the `runId` parameter).
 */

import { log, LOG_ACTIONS } from "./logger/index.js";

/**
 * The shape Vercel AI SDK v6 returns from `result.usage`. Field names
 * differ slightly between major versions; this module accepts both
 * `inputTokens`/`outputTokens` (v6) and `promptTokens`/`completionTokens`
 * (v3-v5) so an SDK upgrade can't silently zero our metrics.
 */
export interface RawLlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  // Legacy v3-v5 field names — accept both for resilience.
  promptTokens?: number;
  completionTokens?: number;
}

/** Normalized usage with all three fields populated. */
export interface NormalizedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Per-callsite tally for the running command. */
interface CallsiteTally {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Module-level accumulator. Cleared by `resetTokenUsage()`.
 * Map<callsite, CallsiteTally>.
 */
const accumulator = new Map<string, CallsiteTally>();

/**
 * Normalize the SDK's usage shape to our canonical fields, defaulting
 * any missing field to 0. Defensive against SDK version drift.
 */
export function normalizeTokenUsage(
  raw: RawLlmUsage | undefined,
): NormalizedTokenUsage {
  if (!raw) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const inputTokens = raw.inputTokens ?? raw.promptTokens ?? 0;
  const outputTokens = raw.outputTokens ?? raw.completionTokens ?? 0;
  const totalTokens = raw.totalTokens ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Record a single LLM call's token usage. Accumulates into the
 * per-callsite tally AND emits a structured TOKEN_USAGE log entry
 * tagged with callsite + runId. Safe to call from any node.
 *
 * The log entry is emitted at info level — visible only with
 * --verbose or ASSIGNEE_LOG_LEVEL=debug — so production users don't
 * see token noise. Persistence to ~/.assignee/logs is also gated by
 * level (info events are stderr-only). To enable analysis, run with
 * --verbose; the resulting jsonl is greppable.
 */
export function recordTokenUsage(
  callsite: string,
  usage: RawLlmUsage | undefined,
  runId?: string,
): NormalizedTokenUsage {
  const normalized = normalizeTokenUsage(usage);

  const existing = accumulator.get(callsite) ?? {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  accumulator.set(callsite, {
    callCount: existing.callCount + 1,
    inputTokens: existing.inputTokens + normalized.inputTokens,
    outputTokens: existing.outputTokens + normalized.outputTokens,
    totalTokens: existing.totalTokens + normalized.totalTokens,
  });

  log({
    ts: new Date().toISOString(),
    runId: runId ?? "unknown",
    level: "info",
    action: LOG_ACTIONS.TOKEN_USAGE,
    extras: {
      callsite,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      totalTokens: normalized.totalTokens,
    },
  });

  return normalized;
}

/**
 * Snapshot of accumulated usage across the command's LLM calls.
 * Used by `result-formatter` to emit one TOKEN_USAGE_SUMMARY entry
 * per command so analysis doesn't require summing individual calls.
 */
export interface TokenUsageSummary {
  /** Total LLM calls made across all callsites in this command. */
  totalCallCount: number;
  /** Total input tokens consumed by ALL calls in this command. */
  totalInputTokens: number;
  /** Total output tokens produced by ALL calls in this command. */
  totalOutputTokens: number;
  /** Sum of input + output across all calls. */
  totalTokens: number;
  /** Per-callsite breakdown: which node burned how many tokens. */
  byCallsite: Record<string, CallsiteTally>;
}

/**
 * Returns the current accumulator snapshot. Does NOT reset.
 * Result-formatter calls this on the SUCCESS branch to emit the
 * end-of-command TOKEN_USAGE_SUMMARY entry.
 */
export function getTokenUsageSummary(): TokenUsageSummary {
  let totalCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  const byCallsite: Record<string, CallsiteTally> = {};
  for (const [callsite, tally] of accumulator.entries()) {
    totalCallCount += tally.callCount;
    totalInputTokens += tally.inputTokens;
    totalOutputTokens += tally.outputTokens;
    totalTokens += tally.totalTokens;
    byCallsite[callsite] = { ...tally };
  }
  return {
    totalCallCount,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    byCallsite,
  };
}

/**
 * Emit a TOKEN_USAGE_SUMMARY log entry capturing the per-callsite
 * totals and the command's grand total. Called by result-formatter
 * (and any other end-of-command callsite) so a single grep on
 * `action=token_usage_summary` returns one row per command.
 *
 * Idempotent — emits even when totals are zero (commands that didn't
 * touch the LLM still produce a summary so analysis can confirm "this
 * command made no LLM calls" rather than "this command's log was
 * truncated").
 */
export function emitTokenUsageSummary(runId: string): TokenUsageSummary {
  const summary = getTokenUsageSummary();
  log({
    ts: new Date().toISOString(),
    runId,
    level: "info",
    action: LOG_ACTIONS.TOKEN_USAGE_SUMMARY,
    extras: {
      totalCallCount: summary.totalCallCount,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      totalTokens: summary.totalTokens,
      byCallsite: summary.byCallsite,
    },
  });
  return summary;
}

/**
 * Reset the accumulator to empty. Called between unit tests AND at
 * the start of every command (defensive — the CLI is single-command
 * per process today, but reset is cheap and protects against future
 * parallel-command execution within one process).
 */
export function resetTokenUsage(): void {
  accumulator.clear();
}
