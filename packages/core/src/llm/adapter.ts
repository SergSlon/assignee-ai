/**
 * LlmAdapter — single-model LlmPort implementation.
 *
 * Lifted from `apps/cli/src/services/llm-adapter/adapter.ts` in
 * Story 50-4 Wave 5 Pass B. Preserves:
 *   - feedback_token_cost_visibility (callsite required in recordTokenUsage)
 *   - feedback_bedrock_region_error_hints (detectBedrockRegionError wrap)
 */
import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import type { ZodSchema } from "zod";
import { LlmError } from "../errors.js";
import { safeTry } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { LlmPort, LlmCallOptions } from "../ports/llm-port.js";
import { AWS_REGION } from "../config/constants/aws.js";
import { LlmProvider } from "../constants/llm-providers.js";
import { recordTokenUsage, type RawLlmUsage } from "../utils/token-usage.js";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  parseModelString,
  type ParsedModel,
} from "./model-parser.js";
import { createLanguageModel } from "./client-factory.js";
import { detectBedrockRegionError } from "./bedrock-region.js";

export interface LlmAdapterConfig {
  /** Model string, e.g. "anthropic/claude-sonnet-4-5". Defaults to DEFAULT_MODEL. */
  modelString?: string;
  /** Optional Bedrock guardrail identifier (only applies to bedrock/ provider). */
  guardrailId?: string;
  /** Optional Bedrock guardrail version. Defaults to "1". */
  guardrailVersion?: string;
}

export class LlmAdapter implements LlmPort {
  private readonly parsed: ParsedModel;
  private readonly guardrailOpts: Record<string, string>;
  private languageModel: LanguageModel | null = null;

  constructor(private readonly config: LlmAdapterConfig = {}) {
    const modelString = config.modelString ?? DEFAULT_MODEL;
    this.parsed = parseModelString(modelString);

    this.guardrailOpts =
      this.parsed.provider === LlmProvider.BEDROCK && config.guardrailId
        ? {
            guardrailIdentifier: config.guardrailId,
            guardrailVersion: config.guardrailVersion ?? "1",
          }
        : {};
  }

  /** Lazily initialize the language model on first call. */
  private async getModel(): Promise<LanguageModel> {
    if (!this.languageModel) {
      this.languageModel = await createLanguageModel(this.parsed);
    }
    return this.languageModel;
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: LlmCallOptions,
  ): Promise<Result<T, LlmError>> {
    const [err, model] = await safeTry(this.getModel());
    if (err) {
      return [
        new LlmError(
          `Failed to initialize LLM model: ${err instanceof Error ? err.message : String(err)}`,
        ),
        null,
      ] as const;
    }

    const [callErr, result] = await safeTry(
      generateText({
        model,
        output: Output.object({ schema }),
        maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...this.guardrailOpts,
        messages: [{ role: "user", content: prompt }],
      }),
    );

    if (callErr) {
      // Wave 12 P2: surface region/availability errors with an actionable hint.
      const regionHint = detectBedrockRegionError(
        callErr,
        AWS_REGION,
        this.config.modelString ?? DEFAULT_MODEL,
      );
      const baseMessage =
        callErr instanceof Error ? callErr.message : String(callErr);
      return [
        new LlmError(
          regionHint ?? `Structured LLM call failed: ${baseMessage}`,
        ),
        null,
      ] as const;
    }

    // Wave 12 P0: token usage instrumentation. Record per-call usage tagged
    // with callsite to answer "which node is the token hog".
    recordTokenUsage(
      options?.callsite ?? "unknown:generateStructured",
      result.usage as RawLlmUsage | undefined,
      options?.runId,
    );

    return [null, result.output as T] as const;
  }

  async generateText(
    prompt: string,
    options?: LlmCallOptions,
  ): Promise<Result<string, LlmError>> {
    const [err, model] = await safeTry(this.getModel());
    if (err) {
      return [
        new LlmError(
          `Failed to initialize LLM model: ${err instanceof Error ? err.message : String(err)}`,
        ),
        null,
      ] as const;
    }

    const [callErr, result] = await safeTry(
      generateText({
        model,
        maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...this.guardrailOpts,
        messages: [{ role: "user", content: prompt }],
      }),
    );

    if (callErr) {
      const regionHint = detectBedrockRegionError(
        callErr,
        AWS_REGION,
        this.config.modelString ?? DEFAULT_MODEL,
      );
      const baseMessage =
        callErr instanceof Error ? callErr.message : String(callErr);
      return [
        new LlmError(regionHint ?? `Text LLM call failed: ${baseMessage}`),
        null,
      ] as const;
    }

    recordTokenUsage(
      options?.callsite ?? "unknown:generateText",
      result.usage as RawLlmUsage | undefined,
      options?.runId,
    );

    return [null, result.text] as const;
  }
}
