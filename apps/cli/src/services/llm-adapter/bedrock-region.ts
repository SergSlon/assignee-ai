/**
 * Bedrock region detector — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core/llm`
 * (lifted in Story 50-4 Wave 5.1 — feedback_bedrock_region_error_hints
 * is preserved across the move).
 */
export {
  detectBedrockRegionError,
  KNOWN_BEDROCK_REGIONS,
} from "@assignee/core/llm";
