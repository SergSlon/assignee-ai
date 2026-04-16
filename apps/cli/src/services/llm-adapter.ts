/**
 * Universal LLM adapter — Wave 6d F5 barrel.
 *
 * Routes requests to any provider via Vercel AI SDK. Provider is driven
 * by the ASSIGNEE_LLM_DEFAULT env var (e.g. `anthropic/claude-sonnet-4-5`,
 * `openai/gpt-4o`, `bedrock/amazon.nova-lite-v1:0`, `ollama/llama3`,
 * `google/gemini-2.0-flash`). NFR-15: maxOutputTokens capped at 1024
 * by default.
 *
 * Implementation split across ./llm-adapter/*:
 *   - model-parser.ts    — parseModelString + DEFAULT_MODEL / DEFAULT_MAX_TOKENS
 *   - client-factory.ts  — per-provider LanguageModel factory (lazy imports)
 *   - bedrock-region.ts  — detectBedrockRegionError + KNOWN_BEDROCK_REGIONS re-export
 *                          (feedback_bedrock_region_error_hints)
 *   - adapter.ts         — LlmAdapter (single-model LlmPort)
 *   - routing-adapter.ts — RoutingLlmAdapter (per-callsite routing, Story 44.1)
 *
 * Preserves feedback_token_cost_visibility: every LLM call passes its
 * callsite to recordTokenUsage inside LlmAdapter so per-command token
 * cost stays greppable.
 */
export {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  parseModelString,
  type ProviderPrefix,
  type ParsedModel,
} from "./llm-adapter/model-parser.js";
export {
  detectBedrockRegionError,
  KNOWN_BEDROCK_REGIONS,
} from "./llm-adapter/bedrock-region.js";
export { LlmAdapter, type LlmAdapterConfig } from "./llm-adapter/adapter.js";
export { RoutingLlmAdapter } from "./llm-adapter/routing-adapter.js";
