/**
 * Port interface for LLM interactions — hexagonal architecture boundary.
 * Nodes depend on this interface; adapters (Bedrock, mock) implement it.
 *
 * @see project-context.md — Dependency Inversion Principle
 * @see Story 9.5 — LLM client decoupling (M3)
 */

import type { ZodSchema } from "zod";
import type { Result } from "../types/result.js";
import type { LlmError } from "../errors.js";

/**
 * Optional shared options for LLM calls.
 *
 * Wave 12 P0: added `callsite` so the adapter can tag every token-usage
 * log line with the calling node's name (intent_parser, plan_generator,
 * advice_generator, etc.). Without this, we cannot answer "which node is
 * the token hog" — and that question gates SaaS unit economics.
 *
 * `runId` is optional but lets the adapter correlate token usage with a
 * specific command invocation when callers have it (every node has one).
 */
export interface LlmCallOptions {
  /** Per-call max output token override. Adapter applies a default cap. */
  maxTokens?: number;
  /**
   * Identifier of the calling node / code path. Used for token-usage
   * attribution in structured logs and the per-command summary. Defaults
   * to "unknown" so legacy callers don't break.
   */
  callsite?: string;
  /**
   * Run ID from the LangGraph state. Threads through to the token_usage
   * log entry so a single command's calls can be grouped during analysis.
   */
  runId?: string;
}

export interface LlmPort {
  /**
   * Generate a structured output validated against a Zod schema.
   * Used by intent_parser to classify resource types.
   *
   * @param prompt - User message content
   * @param schema - Zod schema to validate and type the structured response
   * @param options - Optional call options (maxTokens, callsite, runId)
   */
  generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: LlmCallOptions,
  ): Promise<Result<T, LlmError>>;

  /**
   * Generate raw text output.
   * Used by plan_generator to produce JSON resource configurations.
   *
   * @param prompt - User message content
   * @param options - Optional call options (maxTokens, callsite, runId)
   */
  generateText(
    prompt: string,
    options?: LlmCallOptions,
  ): Promise<Result<string, LlmError>>;
}
