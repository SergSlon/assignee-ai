/**
 * LlmAdapter — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core/llm`
 * (lifted in Story 50-4 Wave 5 Pass B so the in-core graph can
 * construct an LlmAdapter without reaching back into the CLI app).
 *
 * Preserves:
 *   - feedback_token_cost_visibility (LlmAdapter still calls
 *     `recordTokenUsage(callsite, usage, runId)` on every successful
 *     generateText / generateStructured call)
 *   - feedback_bedrock_region_error_hints (detectBedrockRegionError
 *     wraps Bedrock region errors with actionable AWS_REGION guidance)
 */
export { LlmAdapter, type LlmAdapterConfig } from "@assignee/core/llm";
