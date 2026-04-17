/**
 * @assignee/core/llm sub-path barrel.
 *
 * Story 50-4 Wave 5.1: lifted the LLM model-parser and Bedrock-region
 * helper from `apps/cli/src/services/llm-adapter/` so consumers (the
 * in-core graph and CLI alike) can use them without reaching back
 * into the CLI app.
 *
 * The full LlmAdapter (which depends on AWS_REGION + token-usage
 * accumulator + EnvVar — all CLI-side modules with their own deeper
 * dep closures) remains in `apps/cli/src/services/llm-adapter/adapter.ts`
 * pending a future wave that lifts the supporting CLI utilities.
 */
export {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  parseModelString,
  type ProviderPrefix,
  type ParsedModel,
} from "./model-parser.js";
export {
  detectBedrockRegionError,
  KNOWN_BEDROCK_REGIONS,
} from "./bedrock-region.js";
export {
  LlmProvider,
  type LlmProviderType,
} from "../constants/llm-providers.js";
