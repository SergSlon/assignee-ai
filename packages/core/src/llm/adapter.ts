/**
 * LlmAdapter — single-model LlmPort implementation.
 *
 * Lifted from `apps/cli/src/services/llm-adapter/adapter.ts` in
 * Story 50-4 Wave 5 Pass B. Preserves:
 *   - feedback_token_cost_visibility (callsite required in recordTokenUsage)
 *   - feedback_bedrock_region_error_hints (detectBedrockRegionError wrap)
 *
 * W11-S4: Adds exponential-backoff retry for transient Bedrock throttling
 * errors (ThrottlingException / ServiceUnavailableException /
 * TooManyRequestsException). Auth errors, validation errors, and
 * region-availability errors are NOT retried — those are handled by their
 * own code paths. Retry behaviour is controlled by env vars:
 *   ASSIGNEE_LLM_MAX_RETRIES  — integer, default 3
 *   ASSIGNEE_LLM_RETRY_BASE_MS — base delay in ms, default 1000
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
import { EnvVar } from "../constants/env-vars.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";
import { recordTokenUsage, type RawLlmUsage } from "../utils/token-usage.js";
import { redactAccountIdsInPrompt } from "../utils/redact.js";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  parseModelString,
  type ParsedModel,
} from "./model-parser.js";
import { createLanguageModel } from "./client-factory.js";
import { detectBedrockRegionError } from "./bedrock-region.js";
import { stripPromptBoundaryTags } from "./prompt-sanitize.js";

// ── Retry constants ──────────────────────────────────────────────────────────

/**
 * Exception name patterns that warrant an automatic retry.
 * Only transient throttling/availability errors — NOT auth or validation.
 */
const RETRYABLE_ERROR_PATTERNS = [
  "ThrottlingException",
  "ServiceUnavailableException",
  "TooManyRequestsException",
] as const;

/** Default maximum number of retry attempts (excludes the initial attempt). */
const DEFAULT_MAX_RETRIES = 3;

/** Base delay for exponential backoff in milliseconds. */
const DEFAULT_RETRY_BASE_MS = 1_000;

/** Hard ceiling on any single sleep to avoid runaway waits (~30s total). */
const MAX_JITTER_WINDOW_MS = 1_000;

/**
 * Returns true when the error message contains one of the retryable exception
 * names. AWS SDK errors embed the code in the message and/or a `name` property.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.name ?? ""} ${err.message}`;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => text.includes(pattern));
}

/**
 * Compute exponential-backoff delay with full jitter.
 * Formula: random(0, min(cap, base * 2^attempt))
 * @param attempt   zero-based attempt index (0 = first retry)
 * @param baseMs    base delay in milliseconds
 */
export function backoffDelayMs(attempt: number, baseMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const cap = Math.min(exponential, baseMs * 16); // ceiling: 16× base
  return Math.floor(Math.random() * Math.min(cap, cap + MAX_JITTER_WINDOW_MS));
}

/**
 * Reads the retry configuration from environment variables.
 * Falls back to sensible defaults if the vars are absent or invalid.
 */
function readRetryConfig(): { maxRetries: number; baseMs: number } {
  const rawMax = process.env["ASSIGNEE_LLM_MAX_RETRIES"];
  const rawBase = process.env["ASSIGNEE_LLM_RETRY_BASE_MS"];

  const maxRetries =
    rawMax !== undefined && /^\d+$/.test(rawMax)
      ? Math.min(parseInt(rawMax, 10), 10) // hard cap at 10 to avoid abuse
      : DEFAULT_MAX_RETRIES;

  const baseMs =
    rawBase !== undefined && /^\d+$/.test(rawBase)
      ? Math.max(parseInt(rawBase, 10), 100) // floor at 100ms
      : DEFAULT_RETRY_BASE_MS;

  return { maxRetries, baseMs };
}

/**
 * Invoke `fn` with exponential-backoff retry on retryable errors.
 * Non-retryable errors surface immediately without delay.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const { maxRetries, baseMs } = readRetryConfig();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxRetries) {
        throw err;
      }
      const delay = backoffDelayMs(attempt, baseMs);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should never reach here — the loop always throws or returns.
  throw lastErr;
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

    this.guardrailOpts =
      this.parsed.provider === LlmProvider.BEDROCK && config.guardrailId
        ? {
            guardrailIdentifier: config.guardrailId,
            guardrailVersion: config.guardrailVersion ?? "1",
          }
        : {};

    // P018 (acquisition-DD L5 Aiko L5.3 S12): surface missing-guardrail
    // state to operators immediately at adapter construction time, once per
    // instance. This fires when Bedrock is active and no guardrail is
    // configured, unless the operator has explicitly opted out with
    // BEDROCK_GUARDRAIL_DISABLE=1.
    if (
      this.parsed.provider === LlmProvider.BEDROCK &&
      !config.guardrailId &&
      !LlmAdapter.isGuardrailDisabled()
    ) {
      process.stderr.write(
        "WARNING: Bedrock invocations are running WITHOUT a Guardrail. LLM-generated\n" +
          "content may include PII, harmful topics, or jailbreak responses. Set\n" +
          "BEDROCK_GUARDRAIL_ID + BEDROCK_GUARDRAIL_VERSION to enable, or set\n" +
          "BEDROCK_GUARDRAIL_DISABLE=1 to suppress this warning. See `assignee doctor`\n" +
          "for setup guidance.\n",
      );
    }
  }

  /**
   * Returns true if the operator has explicitly opted out of the guardrail warning.
   *
   * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
   * supply a tenant-scoped lookup. When omitted, falls back to a fresh
   * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
   */
  static isGuardrailDisabled(config?: ConfigPort): boolean {
    const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
    const val = effectiveConfig.get(EnvVar.BEDROCK_GUARDRAIL_DISABLE);
    return val === "1" || val === "true";
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

    // Story 55-it1-04 (it55-1-L5-001 + L5-002): sanitize-by-default at
    // the adapter boundary. `stripPromptBoundaryTags` runs FIRST so any
    // `</user_intent><system>ignore</system>` injection embedded in the
    // raw prompt is removed before the redactor decides what to scrub.
    // Per-callsite wraps (plan-generator, advice-generator, display-docs,
    // wizard "other") remain as defence-in-depth but are no longer
    // load-bearing — the adapter strip eliminates the entire L5-H1
    // finding class by construction.
    //
    // Story 54-it1-05 (L5-H2): defence-in-depth — redact ARNs + 12-digit
    // account IDs from the outbound prompt before it leaves the process.
    // The Bedrock path is the only active provider today, but the adapter
    // contract is provider-agnostic and we cannot assume every future
    // backend is equally trustworthy with raw identifiers. Allowlist-based
    // per `feedback_redaction_allowlist_not_denylist`; partition-aware
    // per `feedback_partition_aware_arn_matching`.
    // Epic 92 u.e (D-27): use ARN-preserving account-id redaction so
    // the LLM still sees `arn:aws:sns:us-east-1:[ACCOUNT]:my-topic`
    // (not just `[ARN]`). The model needs the service / region /
    // resource-name parts to generate a plan whose `TopicArn` /
    // `RoleArn` / etc. still points at the user's actual resource,
    // and the plan table shows the same (non-sensitive) information
    // so the user can verify it. The 12-digit account slot is still
    // scrubbed, preserving the L5-H2 security property.
    const sanitizedPrompt = stripPromptBoundaryTags(prompt);
    const redactedPrompt = redactAccountIdsInPrompt(sanitizedPrompt);

    // W11-S4: withRetry wraps the generateText call so transient Bedrock
    // throttling errors (ThrottlingException / ServiceUnavailableException /
    // TooManyRequestsException) are retried up to DEFAULT_MAX_RETRIES times
    // with exponential backoff + jitter before surfacing an error.
    const [callErr, result] = await safeTry(
      withRetry(() =>
        generateText({
          model,
          output: Output.object({ schema }),
          maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...this.guardrailOpts,
          messages: [{ role: "user", content: redactedPrompt }],
        }),
      ),
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

    // Story 55-it1-04 + Story 54-it1-05: sanitize-then-redact at the
    // adapter boundary — mirrors the generateStructured path above. See
    // that comment for rationale + invariant links. Order is critical:
    // boundary-tag strip MUST precede redactSensitive so injected role
    // tags cannot hide ARNs from the redactor.
    // Epic 92 u.e (D-27): use ARN-preserving account-id redaction so
    // the LLM still sees `arn:aws:sns:us-east-1:[ACCOUNT]:my-topic`
    // (not just `[ARN]`). The model needs the service / region /
    // resource-name parts to generate a plan whose `TopicArn` /
    // `RoleArn` / etc. still points at the user's actual resource,
    // and the plan table shows the same (non-sensitive) information
    // so the user can verify it. The 12-digit account slot is still
    // scrubbed, preserving the L5-H2 security property.
    const sanitizedPrompt = stripPromptBoundaryTags(prompt);
    const redactedPrompt = redactAccountIdsInPrompt(sanitizedPrompt);

    // W11-S4: withRetry wraps the generateText call — same retry policy as
    // generateStructured above (ThrottlingException / ServiceUnavailable /
    // TooManyRequests retried with exponential backoff + jitter).
    const [callErr, result] = await safeTry(
      withRetry(() =>
        generateText({
          model,
          maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...this.guardrailOpts,
          messages: [{ role: "user", content: redactedPrompt }],
        }),
      ),
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
