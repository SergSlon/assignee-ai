/**
 * Universal LLM adapter — routes requests to any provider via Vercel AI SDK.
 * Replaces BedrockLlmAdapter as the default LlmPort implementation.
 *
 * Provider routing is driven by the ASSIGNEE_MODEL env var:
 *   - anthropic/claude-sonnet-4-5  -> @ai-sdk/anthropic
 *   - openai/gpt-4o               -> @ai-sdk/openai
 *   - bedrock/amazon.nova-lite-v1:0 -> @ai-sdk/amazon-bedrock
 *   - ollama/llama3                -> @ai-sdk/openai (OpenAI-compatible endpoint)
 *   - google/gemini-2.0-flash      -> @ai-sdk/google
 *
 * NFR-15: maxOutputTokens capped at 1024 by default.
 *
 * @see Story 14.1 — LLM Provider Gateway Integration
 */

import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import type { ZodSchema } from "zod";
import { LlmError, safeTry } from "@assignee/core";
import type { LlmPort, Result } from "@assignee/core";
import { AWS_REGION } from "../config/constants.js";
import { EnvVar } from "../constants/env-vars.js";
import { LlmProvider, type LlmProviderType } from "../constants/errors.js";

/** Supported provider prefixes. */
export type ProviderPrefix = LlmProviderType;

export interface ParsedModel {
  provider: ProviderPrefix;
  modelId: string;
}

/** Default model when ASSIGNEE_MODEL is unset — backward compatible. */
export const DEFAULT_MODEL = `${LlmProvider.BEDROCK}/amazon.nova-lite-v1:0`;

/** Default maxOutputTokens per NFR-15. */
export const DEFAULT_MAX_TOKENS = 1024;

const VALID_PROVIDERS: ReadonlySet<string> = new Set(
  Object.values(LlmProvider),
);

/**
 * Parse a model string like "anthropic/claude-sonnet-4-5" into provider + modelId.
 * Throws LlmError if the format is invalid.
 */
export function parseModelString(modelString: string): ParsedModel {
  const slashIndex = modelString.indexOf("/");
  if (slashIndex === -1) {
    throw new LlmError(
      `Invalid ASSIGNEE_MODEL format: "${modelString}". Expected "provider/model-id" (e.g. "anthropic/claude-sonnet-4-5").`,
    );
  }

  const provider = modelString.slice(0, slashIndex);
  const modelId = modelString.slice(slashIndex + 1);

  if (!modelId) {
    throw new LlmError(
      `Invalid ASSIGNEE_MODEL format: "${modelString}". Model ID is empty after provider prefix.`,
    );
  }

  if (!VALID_PROVIDERS.has(provider)) {
    throw new LlmError(
      `Unsupported provider "${provider}" in ASSIGNEE_MODEL. Supported: ${[...VALID_PROVIDERS].join(", ")}.`,
    );
  }

  return { provider: provider as ProviderPrefix, modelId };
}

/**
 * Create a Vercel AI SDK LanguageModel for the given parsed model.
 * Dynamically imports the provider package to avoid loading unused SDKs.
 */
async function createLanguageModel(
  parsed: ParsedModel,
): Promise<LanguageModel> {
  switch (parsed.provider) {
    case LlmProvider.ANTHROPIC: {
      if (!process.env["ANTHROPIC_API_KEY"]) {
        throw new LlmError(
          `ANTHROPIC_API_KEY environment variable is required for ${LlmProvider.ANTHROPIC}/ models.`,
        );
      }
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({
        apiKey: process.env["ANTHROPIC_API_KEY"],
      });
      return anthropic(parsed.modelId);
    }

    case LlmProvider.OPENAI: {
      if (!process.env["OPENAI_API_KEY"]) {
        throw new LlmError(
          `OPENAI_API_KEY environment variable is required for ${LlmProvider.OPENAI}/ models.`,
        );
      }
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
      return openai(parsed.modelId);
    }

    case LlmProvider.BEDROCK: {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
      const bedrock = createAmazonBedrock({
        region: AWS_REGION,
        accessKeyId: process.env[EnvVar.OPERATOR_ACCESS_KEY],
        secretAccessKey: process.env[EnvVar.OPERATOR_SECRET_KEY],
      });
      return bedrock(parsed.modelId);
    }

    case LlmProvider.OLLAMA: {
      const baseURL =
        process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1";
      const { createOpenAI } = await import("@ai-sdk/openai");
      const ollama = createOpenAI({
        baseURL,
        apiKey: LlmProvider.OLLAMA, // Ollama doesn't need a real key
      });
      return ollama(parsed.modelId);
    }

    case LlmProvider.GOOGLE: {
      if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
        throw new LlmError(
          `GOOGLE_GENERATIVE_AI_API_KEY environment variable is required for ${LlmProvider.GOOGLE}/ models.`,
        );
      }
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({
        apiKey: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
      });
      return google(parsed.modelId);
    }
  }
}

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

    // Bedrock guardrails only apply to bedrock provider
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
    options?: { maxTokens?: number },
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
      return [
        new LlmError(
          `Structured LLM call failed: ${callErr instanceof Error ? callErr.message : String(callErr)}`,
        ),
        null,
      ] as const;
    }

    return [null, result.output as T] as const;
  }

  async generateText(
    prompt: string,
    options?: { maxTokens?: number },
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
      return [
        new LlmError(
          `Text LLM call failed: ${callErr instanceof Error ? callErr.message : String(callErr)}`,
        ),
        null,
      ] as const;
    }

    return [null, result.text] as const;
  }
}
