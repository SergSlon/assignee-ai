/**
 * Bedrock region/availability error detection.
 *
 * Wave 12 P2 / feedback_bedrock_region_error_hints: wrap Bedrock access errors
 * with an actionable hint naming the current AWS_REGION, the model, and the
 * suggested fix. Returns null when the error is something else (network,
 * throttling, missing creds, generic 5xx) so the caller falls back to the
 * original error message.
 *
 * Extracted from llm-adapter.ts (Wave 6d F5).
 */
import { KNOWN_BEDROCK_REGIONS } from "../../constants/bedrock-regions.js";
import { LlmProvider } from "../../constants/errors.js";

export { KNOWN_BEDROCK_REGIONS };

export function detectBedrockRegionError(
  err: unknown,
  region: string,
  modelString: string,
): string | null {
  if (!modelString.startsWith(`${LlmProvider.BEDROCK}/`)) {
    return null;
  }

  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return null;

  const REGION_ERROR_PATTERNS = [
    /AccessDeniedException/i,
    /ValidationException/i,
    /ResourceNotFoundException/i,
    /could not resolve the foundation model/i,
    /the provided model identifier is invalid/i,
    /you don't have access to the model/i,
    /not authorized to invoke/i,
  ];

  if (!REGION_ERROR_PATTERNS.some((p) => p.test(message))) {
    return null;
  }

  const onKnownRegion = KNOWN_BEDROCK_REGIONS.includes(region);
  const suggestion = onKnownRegion
    ? `Your account may not be enrolled in this model in ${region}. Open the Bedrock console → Model access → request access to the model, OR set ASSIGNEE_LLM_DEFAULT to a different model that IS enabled in ${region}.`
    : `${region} is not on the canonical Bedrock-enabled list. Set AWS_REGION to one of: ${KNOWN_BEDROCK_REGIONS.join(", ")}, OR set ASSIGNEE_LLM_DEFAULT to a non-Bedrock provider (e.g. anthropic/claude-sonnet-4-5 with ANTHROPIC_API_KEY).`;

  return (
    `Bedrock model "${modelString}" is not available in AWS_REGION=${region}. ` +
    `${suggestion} ` +
    `Original AWS error: ${message}`
  );
}
