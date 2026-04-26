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
import { EnvVar } from "../constants/env-vars.js";
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

  /** Returns true if the operator has explicitly opted out of the guardrail warning. */
  static isGuardrailDisabled(): boolean {
    const val = process.env[EnvVar.BEDROCK_GUARDRAIL_DISABLE];
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

    const [callErr, result] = await safeTry(
      generateText({
        model,
        output: Output.object({ schema }),
        maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...this.guardrailOpts,
        messages: [{ role: "user", content: redactedPrompt }],
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

    const [callErr, result] = await safeTry(
      generateText({
        model,
        maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...this.guardrailOpts,
        messages: [{ role: "user", content: redactedPrompt }],
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
