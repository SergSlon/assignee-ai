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
import type { LlmPort, LlmCallOptions, Result } from "@assignee/core";
import { AWS_REGION } from "../config/constants.js";
import { EnvVar } from "../constants/env-vars.js";
import { LlmProvider, type LlmProviderType } from "../constants/errors.js";
import { recordTokenUsage, type RawLlmUsage } from "../utils/token-usage.js";

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

/**
 * Wave 12 P2: AWS regions where Bedrock + the canonical Anthropic
 * Claude / Amazon Nova models are confirmed enabled and available
 * (snapshot 2026-04). When a user runs `assignee` from a region NOT
 * on this list, the wrap-friendly error in `wrapBedrockRegionError`
 * suggests setting AWS_REGION to one of these.
 *
 * This is intentionally a SHORT list (the canonical "everyone uses these"
 * regions) rather than the exhaustive AWS region availability matrix —
 * the goal is "give the user a working AWS_REGION value", not "document
 * AWS service availability".
 */
export const KNOWN_BEDROCK_REGIONS: readonly string[] = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-central-1",
  "eu-west-1",
  "eu-west-3",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
] as const;

/**
 * Wave 12 P2: detect a Bedrock region/availability error and return
 * an actionable hint, or `null` for any other error shape.
 *
 * AWS Bedrock raises several error patterns when the model isn't
 * available in the configured region:
 *   - `AccessDeniedException`: model exists in some regions but not
 *     enabled in the caller's region or for the caller's account
 *   - `ValidationException` w/ "model identifier is invalid": the
 *     model ID is not recognized in this region
 *   - `ResourceNotFoundException`: model not present in this region
 *   - `Could not resolve the foundation model from the provided model
 *     identifier`: same root cause, different message format
 *
 * The user-visible failure has historically been opaque ("LLM invoke
 * failed: AccessDeniedException"), forcing a docs hunt. This helper
 * recognizes the pattern and returns a hint that names the current
 * region, the model, and the suggested fix (set AWS_REGION to a
 * supported one). Returns null when the error is something else
 * (network failure, throttling, missing creds, generic 5xx) so the
 * caller falls back to the original error message.
 */
export function detectBedrockRegionError(
  err: unknown,
  region: string,
  modelString: string,
): string | null {
  if (!modelString.startsWith(`${LlmProvider.BEDROCK}/`)) {
    return null;
  }

  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return null;

  // Patterns observed across Bedrock provider error variants
  const REGION_ERROR_PATTERNS = [
    /AccessDeniedException/i,
    /ValidationException/i,
    /ResourceNotFoundException/i,
    /could not resolve the foundation model/i,
    /the provided model identifier is invalid/i,
    /you don't have access to the model/i,
    /not authorized to invoke/i,
  ];

  if (!REGION_ERROR_PATTERNS.some((p) => p.test(message))) {
    return null;
  }

  const onKnownRegion = KNOWN_BEDROCK_REGIONS.includes(region);
  const suggestion = onKnownRegion
    ? `Your account may not be enrolled in this model in ${region}. Open the Bedrock console → Model access → request access to the model, OR set ASSIGNEE_MODEL to a different model that IS enabled in ${region}.`
    : `${region} is not on the canonical Bedrock-enabled list. Set AWS_REGION to one of: ${KNOWN_BEDROCK_REGIONS.join(", ")}, OR set ASSIGNEE_MODEL to a non-Bedrock provider (e.g. anthropic/claude-sonnet-4-5 with ANTHROPIC_API_KEY).`;

  return (
    `Bedrock model "${modelString}" is not available in AWS_REGION=${region}. ` +
    `${suggestion} ` +
    `Original AWS error: ${message}`
  );
}

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
      // Wave 12 P2: surface region/availability errors with an actionable
      // hint instead of the opaque AccessDeniedException string. The hint
      // names the current AWS_REGION, the model, and the recommended fix.
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

    // Wave 12 P0: token usage instrumentation. Record per-call usage
    // tagged with the calling node's callsite so we can answer "which
    // node is the token hog" — gates SaaS unit economics. Defensive
    // against missing usage field (mocked SDKs, partial response).
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
      // Wave 12 P2: same Bedrock-region hint as generateStructured.
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

    // Wave 12 P0: token usage instrumentation — see generateStructured above.
    recordTokenUsage(
      options?.callsite ?? "unknown:generateText",
      result.usage as RawLlmUsage | undefined,
      options?.runId,
    );

    return [null, result.text] as const;
  }
}

/**
 * Story 44.1: Routing adapter that delegates to per-callsite LlmAdapter
 * instances. Each unique model string shares a single adapter (lazy cache).
 *
 * When no routing config key matches the call's callsite, falls back to
 * "default" → ASSIGNEE_MODEL env var → DEFAULT_MODEL constant, preserving
 * full backward compatibility.
 */
export class RoutingLlmAdapter implements LlmPort {
  private readonly routingConfig: Readonly<Record<string, string>>;
  private readonly adapterCache = new Map<string, LlmAdapter>();
  private readonly baseConfig: Omit<LlmAdapterConfig, "modelString">;

  constructor(
    routingConfig: Record<string, string | undefined>,
    baseConfig: Omit<LlmAdapterConfig, "modelString"> = {},
  ) {
    // Strip undefined values so lookups are clean string-only
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(routingConfig)) {
      if (v !== undefined) clean[k] = v;
    }
    this.routingConfig = clean;
    this.baseConfig = baseConfig;
  }

  /** Resolve the adapter for a given callsite, lazily creating if needed. */
  private getAdapter(callsite?: string): LlmAdapter {
    const modelString =
      (callsite ? this.routingConfig[callsite] : undefined) ??
      this.routingConfig["default"] ??
      process.env[EnvVar.ASSIGNEE_MODEL] ??
      DEFAULT_MODEL;

    let adapter = this.adapterCache.get(modelString);
    if (!adapter) {
      adapter = new LlmAdapter({ ...this.baseConfig, modelString });
      this.adapterCache.set(modelString, adapter);
    }
    return adapter;
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: LlmCallOptions,
  ): Promise<Result<T, LlmError>> {
    return this.getAdapter(options?.callsite).generateStructured(
      prompt,
      schema,
      options,
    );
  }

  async generateText(
    prompt: string,
    options?: LlmCallOptions,
  ): Promise<Result<string, LlmError>> {
    return this.getAdapter(options?.callsite).generateText(prompt, options);
  }
}
