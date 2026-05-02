/**
 * @assignee/core/llm sub-path barrel.
 *
 * Story 50-4 Wave 5.1: lifted the LLM model-parser and Bedrock-region
 * helper from `apps/cli/src/services/llm-adapter/` so consumers (the
 * in-core graph and CLI alike) can use them without reaching back
 * into the CLI.
 *
 * Story 50-4 Wave 5 Pass B: lifted the LlmAdapter production class
 * here too, now that its deps (AWS_REGION, token-usage, logger,
 * EnvVar) are all in core thanks to Pass A.
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
  detectBedrockModelLifecycle,
  KNOWN_BEDROCK_REGIONS,
  type BedrockLifecycleClient,
  type BedrockModelLifecycleResult,
  type GetFoundationModelCommandFactory,
} from "./bedrock-region.js";
export {
  LlmProvider,
  type LlmProviderType,
} from "../constants/llm-providers.js";
export {
  LlmAdapter,
  type LlmAdapterConfig,
  parseBoolEnv,
  recordThrottleRetry,
  _resetRetryBudgetForTest,
} from "./adapter.js";
export { createLanguageModel } from "./client-factory.js";
export {
  stripPromptBoundaryTags,
  BOUNDARY_TAG_ALLOWLIST,
} from "./prompt-sanitize.js";
