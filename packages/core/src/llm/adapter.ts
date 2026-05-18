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
import { LlmError, GuardrailRequiredError } from "../errors.js";
import { safeTry } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { LlmPort, LlmCallOptions } from "../ports/llm-port.js";
import { AWS_REGION } from "../config/constants/aws.js";
import { LlmProvider } from "../constants/llm-providers.js";
import { EnvVar } from "../constants/env-vars.js";
import {
  type ConfigPort,
  ProcessEnvConfigAdapter,
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

/** Hard upper bound on ASSIGNEE_LLM_RETRY_BASE_MS to prevent runaway sleeps. */
const MAX_RETRY_BASE_MS = 30_000;

/** Hard upper bound on ASSIGNEE_LLM_MAX_GLOBAL_RETRIES. */
const MAX_GLOBAL_RETRIES = 100;

// ── SEC-028: Global retry circuit-breaker ────────────────────────────────────

/**
 * Maximum cumulative throttle retries (across ALL concurrent calls) within
 * the circuit-breaker window before fast-failing subsequent throttle errors.
 * Default: 20. Configurable via ASSIGNEE_LLM_MAX_GLOBAL_RETRIES.
 */
const DEFAULT_BEDROCK_MAX_GLOBAL_RETRIES = 20;

/** Time window in ms for the global retry circuit-breaker. Default: 60s. */
const RETRY_BUDGET_WINDOW_MS = 60_000;

/** Process-global throttle-retry counter (count + window start timestamp). */
const _retryBudget = {
  count: 0,
  windowStart: 0,
};

/**
 * Reads the global-retry budget limit via ConfigPort.
 * Falls back to DEFAULT_BEDROCK_MAX_GLOBAL_RETRIES.
 * Clamps to [1, MAX_GLOBAL_RETRIES] to defang DoS amplification.
 */
function readGlobalRetryLimit(config: ConfigPort): number {
  const raw = config.getInt(EnvVar.ASSIGNEE_LLM_MAX_GLOBAL_RETRIES);
  if (raw !== undefined) {
    return Math.min(Math.max(raw, 1), MAX_GLOBAL_RETRIES);
  }
  return DEFAULT_BEDROCK_MAX_GLOBAL_RETRIES;
}

/**
 * Records a throttle retry in the process-global budget window.
 * Returns `true` when the budget is exhausted (fast-fail should be applied).
 *
 * SEC-028: Prevents retry storms under coordinated DoS by capping the total
 * number of ThrottlingException retries across all concurrent calls within
 * a 60s sliding window.
 */
export function recordThrottleRetry(config?: ConfigPort): boolean {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  const now = Date.now();
  if (now - _retryBudget.windowStart > RETRY_BUDGET_WINDOW_MS) {
    // Reset the window.
    _retryBudget.count = 0;
    _retryBudget.windowStart = now;
  }
  _retryBudget.count += 1;
  return _retryBudget.count > readGlobalRetryLimit(effectiveConfig);
}

/**
 * Resets the global retry budget. Exposed for tests only — do NOT call in
 * production code.
 * @internal
 */
export function _resetRetryBudgetForTest(): void {
  _retryBudget.count = 0;
  _retryBudget.windowStart = 0;
}

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
 * Returns true when the error is specifically a ThrottlingException (the only
 * error type counted against the global retry budget).
 */
function isThrottlingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.name ?? ""} ${err.message}`;
  return text.includes("ThrottlingException");
}

/**
 * Compute exponential-backoff delay with full jitter.
 * Formula: random(0, min(base * 2^attempt, base * 16))
 * Ceiling: 16× baseMs (16s with default 1s base).
 * @param attempt   zero-based attempt index (0 = first retry)
 * @param baseMs    base delay in milliseconds
 */
export function backoffDelayMs(attempt: number, baseMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const cap = Math.min(exponential, baseMs * 16); // ceiling: 16× base
  return Math.floor(Math.random() * cap);
}

/**
 * Reads the retry configuration via ConfigPort.
 * Falls back to sensible defaults if the vars are absent or invalid.
 * Clamps to safe ranges to defang DoS amplification (maxRetries ≤ 10,
 * baseMs in [100, MAX_RETRY_BASE_MS]).
 */
function readRetryConfig(config: ConfigPort): {
  maxRetries: number;
  baseMs: number;
} {
  const rawMax = config.getInt(EnvVar.ASSIGNEE_LLM_MAX_RETRIES);
  const rawBase = config.getInt(EnvVar.ASSIGNEE_LLM_RETRY_BASE_MS);

  const maxRetries =
    rawMax !== undefined
      ? Math.min(Math.max(rawMax, 0), 10) // hard cap at 10 to avoid abuse
      : DEFAULT_MAX_RETRIES;

  const baseMs =
    rawBase !== undefined
      ? Math.min(Math.max(rawBase, 100), MAX_RETRY_BASE_MS) // floor 100ms, ceiling 30s
      : DEFAULT_RETRY_BASE_MS;

  return { maxRetries, baseMs };
}

/**
 * Invoke `fn` with exponential-backoff retry on retryable errors.
 * Non-retryable errors surface immediately without delay.
 *
 * SEC-028: ThrottlingExceptions also contribute to the process-global
 * retry budget. Once the budget is exhausted within the 60s window,
 * subsequent ThrottlingExceptions fast-fail without retrying and emit a
 * structured `retryBudgetExhausted` log event to stderr.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  config: ConfigPort,
): Promise<T> {
  const { maxRetries, baseMs } = readRetryConfig(config);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxRetries) {
        throw err;
      }
      // SEC-028: count ThrottlingException retries against the global budget.
      if (isThrottlingError(err)) {
        const budgetExhausted = recordThrottleRetry(config);
        if (budgetExhausted) {
          process.stderr.write(
            JSON.stringify({
              level: "ERROR",
              event: "retryBudgetExhausted",
              message:
                "Global ThrottlingException retry budget exhausted within 60s window. " +
                "Fast-failing subsequent throttle errors to prevent retry storm.",
            }) + "\n",
          );
          throw err;
        }
      }
      const delay = backoffDelayMs(attempt, baseMs);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should never reach here — the loop always throws or returns.
  throw lastErr;
}

// ── SEC-036: Strict boolean env-var parser ───────────────────────────────────

/**
 * Parses a boolean environment variable using strict mode: only the value
 * `"1"` is treated as truthy. All other values (including `"true"`, `"True"`,
 * `"TRUE"`, `"yes"`, `"on"`) return `false`.
 *
 * SEC-036: Normalises bool env-var parsing across assignee so typo variants
 * like "True" cannot silently disable security-critical flags.
 *
 * @param name - The environment variable name to read from `process.env`.
 * @returns `true` iff the env var is set to the string `"1"`.
 */
export function parseBoolEnv(name: string): boolean {
  return process.env[name] === "1";
}

export interface LlmAdapterConfig {
  /** Model string, e.g. "anthropic/claude-sonnet-4-5". Defaults to DEFAULT_MODEL. */
  modelString?: string;
  /** Optional Bedrock guardrail identifier (only applies to bedrock/ provider). */
  guardrailId?: string;
  /** Optional Bedrock guardrail version. Defaults to "1". */
  guardrailVersion?: string;
  /**
   * MASTER-009: optional tenant-scoped config source. When omitted a fresh
   * ProcessEnvConfigAdapter is used (preserves single-tenant CLI behaviour).
   */
  configPort?: ConfigPort;
}

/** Provider names that have already emitted the no-guardrail warning in this process. */
const _nonBedrockProvidersWarned = new Set<string>();

export class LlmAdapter implements LlmPort {
  private readonly parsed: ParsedModel;
  private readonly guardrailOpts: Record<string, string>;
  private readonly configPort: ConfigPort;
  private languageModel: LanguageModel | null = null;

  constructor(private readonly config: LlmAdapterConfig = {}) {
    this.configPort = config.configPort ?? new ProcessEnvConfigAdapter();
    const modelString = config.modelString ?? DEFAULT_MODEL;
    this.parsed = parseModelString(modelString);

    this.guardrailOpts =
      this.parsed.provider === LlmProvider.BEDROCK && config.guardrailId
        ? {
            guardrailIdentifier: config.guardrailId,
            guardrailVersion: config.guardrailVersion ?? "1",
          }
        : {};

    // SEC-016 / P018: Bedrock without a guardrail now emits a warning at
    // construction time. The fail-closed gate (GuardrailRequiredError) fires
    // at call time (generateText / generateStructured) so callers that set
    // ASSIGNEE_ALLOW_NO_GUARDRAIL=1 still get a warning here.
    if (this.parsed.provider === LlmProvider.BEDROCK && !config.guardrailId) {
      if (
        !LlmAdapter.isGuardrailDisabled(this.configPort) &&
        !LlmAdapter.isAllowNoGuardrail(this.configPort)
      ) {
        process.stderr.write(
          "WARNING: Bedrock invocations are running WITHOUT a Guardrail. LLM-generated\n" +
            "content may include PII, harmful topics, or jailbreak responses. Set\n" +
            "BEDROCK_GUARDRAIL_ID + BEDROCK_GUARDRAIL_VERSION to enable, or set\n" +
            "BEDROCK_GUARDRAIL_DISABLE=1 to suppress this warning. See `assignee admin doctor`\n" +
            "for setup guidance.\n",
        );
      }
    }

    // SEC-042: Non-Bedrock providers have no guardrail coverage at all.
    // Emit a one-time per-provider warning in this process unless the operator
    // has explicitly set ASSIGNEE_ALLOW_NO_GUARDRAIL=1.
    if (
      this.parsed.provider !== LlmProvider.BEDROCK &&
      !LlmAdapter.isAllowNoGuardrail(this.configPort) &&
      !_nonBedrockProvidersWarned.has(this.parsed.provider)
    ) {
      _nonBedrockProvidersWarned.add(this.parsed.provider);
      process.stderr.write(
        `WARNING: Provider ${this.parsed.provider} has no guardrail coverage. ` +
          "Set ASSIGNEE_ALLOW_NO_GUARDRAIL=1 to suppress.\n",
      );
    }
  }

  /**
   * Returns true if the operator has explicitly opted out of the guardrail
   * warning AND the fail-closed gate via `BEDROCK_GUARDRAIL_DISABLE=1`.
   *
   * SEC-036: accepts ONLY the value `"1"` (via `parseBoolEnv`). `"true"`,
   * `"True"`, `"TRUE"` etc. are no longer accepted — use `"1"` consistently
   * with all other assignee bool env vars.
   *
   * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
   * supply a tenant-scoped lookup. When omitted, falls back to a fresh
   * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
   */
  static isGuardrailDisabled(config?: ConfigPort): boolean {
    if (config) {
      // ConfigPort path: still check for strict "1" only.
      return config.get(EnvVar.BEDROCK_GUARDRAIL_DISABLE) === "1";
    }
    return parseBoolEnv(EnvVar.BEDROCK_GUARDRAIL_DISABLE);
  }

  /**
   * Returns true if the operator has explicitly opted out of the
   * guardrail-required gate via `ASSIGNEE_ALLOW_NO_GUARDRAIL=1`.
   *
   * SEC-016 / SEC-042: when set to `"1"`, the fail-closed Bedrock gate and
   * the non-Bedrock per-adapter warning are both suppressed. Only `"1"` is
   * accepted (strict `parseBoolEnv`).
   */
  static isAllowNoGuardrail(config?: ConfigPort): boolean {
    if (config) {
      return config.get(EnvVar.ASSIGNEE_ALLOW_NO_GUARDRAIL) === "1";
    }
    return parseBoolEnv(EnvVar.ASSIGNEE_ALLOW_NO_GUARDRAIL);
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
    // SEC-016: Fail-closed guardrail gate. If the Bedrock provider is active
    // and no guardrailId was provided at construction time, reject the call
    // unless the operator has explicitly set ASSIGNEE_ALLOW_NO_GUARDRAIL=1.
    if (
      this.parsed.provider === LlmProvider.BEDROCK &&
      !this.config.guardrailId &&
      !LlmAdapter.isAllowNoGuardrail(this.configPort) &&
      !LlmAdapter.isGuardrailDisabled(this.configPort)
    ) {
      return [new GuardrailRequiredError(), null] as const;
    }

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
      withRetry(
        () =>
          generateText({
            model,
            output: Output.object({ schema }),
            maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...this.guardrailOpts,
            messages: [{ role: "user", content: redactedPrompt }],
          }),
        this.configPort,
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
    // SEC-016: Fail-closed guardrail gate — mirrors generateStructured above.
    if (
      this.parsed.provider === LlmProvider.BEDROCK &&
      !this.config.guardrailId &&
      !LlmAdapter.isAllowNoGuardrail(this.configPort) &&
      !LlmAdapter.isGuardrailDisabled(this.configPort)
    ) {
      return [new GuardrailRequiredError(), null] as const;
    }

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
      withRetry(
        () =>
          generateText({
            model,
            maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...this.guardrailOpts,
            messages: [{ role: "user", content: redactedPrompt }],
          }),
        this.configPort,
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
