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

export interface LlmPort {
  /**
   * Generate a structured output validated against a Zod schema.
   * Used by intent_parser to classify resource types.
   *
   * @param prompt - User message content
   * @param schema - Zod schema to validate and type the structured response
   * @param options - Optional overrides (e.g. maxTokens)
   */
  generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: { maxTokens?: number },
  ): Promise<Result<T, LlmError>>;

  /**
   * Generate raw text output.
   * Used by plan_generator to produce JSON resource configurations.
   *
   * @param prompt - User message content
   * @param options - Optional overrides (e.g. maxTokens)
   */
  generateText(
    prompt: string,
    options?: { maxTokens?: number },
  ): Promise<Result<string, LlmError>>;
}
