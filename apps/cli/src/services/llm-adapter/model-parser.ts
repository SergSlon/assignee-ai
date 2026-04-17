/**
 * Model parser — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core/llm`
 * (lifted in Story 50-4 Wave 5.1 so the in-core LLM helpers and the
 * future in-core graph can use it without reaching back into the CLI).
 */
export {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  parseModelString,
  type ProviderPrefix,
  type ParsedModel,
} from "@assignee/core/llm";
