/**
 * Production LlmPort adapter — wraps the Vercel AI SDK + Amazon Bedrock provider.
 * Constructed once in graph.ts and injected into nodes; never imported directly by nodes.
 *
 * NFR-15: maxOutputTokens capped at 1024 by default.
 * Guardrail: reads BEDROCK_GUARDRAIL_ID / BEDROCK_GUARDRAIL_VERSION env vars at construction.
 *
 * @see Story 9.5 — LLM client decoupling (M3)
 */

import { generateText, Output } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { ZodSchema } from "zod";
import { LlmError, safeTry } from "@assignee/core";
import type { LlmPort, Result } from "@assignee/core";

interface BedrockAdapterConfig {
  modelId: string;
  region: string;
  /** Optional Bedrock guardrail identifier (NFR-16). */
  guardrailId?: string;
  /** Optional Bedrock guardrail version. Defaults to "1". */
  guardrailVersion?: string;
}

export class BedrockLlmAdapter implements LlmPort {
  private readonly bedrock: ReturnType<typeof createAmazonBedrock>;
  private readonly guardrailOpts: Record<string, string>;

  constructor(private readonly config: BedrockAdapterConfig) {
    this.bedrock = createAmazonBedrock({ region: config.region });
    this.guardrailOpts = config.guardrailId
      ? {
          guardrailIdentifier: config.guardrailId,
          guardrailVersion: config.guardrailVersion ?? "1",
        }
      : {};
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: { maxTokens?: number },
  ): Promise<Result<T, LlmError>> {
    const [err, result] = await safeTry(
      generateText({
        model: this.bedrock(this.config.modelId),
        output: Output.object({ schema }),
        maxOutputTokens: options?.maxTokens ?? 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    );

    if (err) {
      return [
        new LlmError(
          `Structured LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
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
    const [err, result] = await safeTry(
      generateText({
        model: this.bedrock(this.config.modelId),
        maxOutputTokens: options?.maxTokens ?? 1024,
        ...this.guardrailOpts,
        messages: [{ role: "user", content: prompt }],
      }),
    );

    if (err) {
      return [
        new LlmError(
          `Text LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
        null,
      ] as const;
    }

    return [null, result.text] as const;
  }
}
