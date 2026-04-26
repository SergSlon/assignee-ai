/**
 * LLM adapter factory for command bootstrap.
 *
 * Story 50-7: RoutingLlmAdapter (per-callsite routing, Story 44.1) was
 * removed because no in-repo YAML used the `llm:` key. This factory
 * now constructs a single `LlmAdapter` and optionally wraps with
 * `RecordingLlmAdapter` when ASSIGNEE_RECORD=1 is active.
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
}

/**
 * Build the llm client used by the graph. Returns `undefined` when no
 * recorder is active — in that case the graph falls back to its default
 * LlmAdapter construction.
 */
export async function buildLlmClient(
  opts: LlmFactoryOpts,
): Promise<LlmPort | undefined> {
  if (!opts.recorder) return undefined;
  const { LlmAdapter } = await import("@assignee/core/llm");
  const baseLlm = new LlmAdapter({
    modelString:
      process.env[EnvVar.ASSIGNEE_LLM_DEFAULT] ??
      // Back-compat: read legacy ASSIGNEE_MODEL env var (deprecated alias).
      process.env["ASSIGNEE_MODEL"],
    guardrailId: process.env[EnvVar.BEDROCK_GUARDRAIL_ID],
    guardrailVersion: process.env[EnvVar.BEDROCK_GUARDRAIL_VERSION],
  });
  return new RecordingLlmAdapter(
    baseLlm,
    opts.recorder,
    process.env[EnvVar.ASSIGNEE_LLM_DEFAULT] ??
      // Back-compat: read legacy ASSIGNEE_MODEL env var (deprecated alias).
      process.env["ASSIGNEE_MODEL"] ??
      "bedrock/amazon.nova-lite-v1:0",
  );
}
