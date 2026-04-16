/**
 * LLM adapter factory for command bootstrap.
 *
 * Extracted from command-runner.ts (Wave 6d F5). Picks between
 * LlmAdapter (single-model) and RoutingLlmAdapter (per-callsite routing)
 * based on resolved config. Optionally wraps with RecordingLlmAdapter
 * when ASSIGNEE_RECORD=1 is active.
 *
 * Preserves feedback_token_cost_visibility (callsite flows through the
 * LlmCallOptions) and feedback_bedrock_region_error_hints (wrapping
 * applied inside LlmAdapter itself).
 */
import type { LlmPort } from "@assignee/core";
import { EnvVar } from "../../constants/env-vars.js";
import { RecordingInterceptor, RecordingLlmAdapter } from "../recorder.js";

interface LlmFactoryOpts {
  recorder: RecordingInterceptor | null;
  resolvedConfig?: { llm?: Record<string, string | undefined> };
}

/**
 * Build the llm client used by the graph. Returns `undefined` when no
 * recorder is active AND no routing config is present — in that case the
 * graph falls back to its default LlmAdapter construction.
 */
export async function buildLlmClient(
  opts: LlmFactoryOpts,
): Promise<LlmPort | undefined> {
  const { LlmAdapter, RoutingLlmAdapter } =
    await import("../../services/llm-adapter.js");
  const llmBaseConfig = {
    guardrailId: process.env[EnvVar.BEDROCK_GUARDRAIL_ID],
    guardrailVersion: process.env[EnvVar.BEDROCK_GUARDRAIL_VERSION],
  };
  const llmRouting = opts.resolvedConfig?.llm;
  const baseLlm =
    llmRouting && Object.keys(llmRouting).length > 0
      ? new RoutingLlmAdapter(llmRouting, llmBaseConfig)
      : new LlmAdapter({
          modelString:
            process.env[EnvVar.ASSIGNEE_LLM_DEFAULT] ??
            process.env[EnvVar.ASSIGNEE_MODEL],
          ...llmBaseConfig,
        });
  if (!opts.recorder) return undefined;
  return new RecordingLlmAdapter(
    baseLlm,
    opts.recorder,
    process.env[EnvVar.ASSIGNEE_LLM_DEFAULT] ??
      process.env[EnvVar.ASSIGNEE_MODEL] ??
      "bedrock/amazon.nova-lite-v1:0",
  );
}
