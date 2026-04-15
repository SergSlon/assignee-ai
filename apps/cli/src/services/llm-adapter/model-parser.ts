/**
 * Parse ASSIGNEE_MODEL strings (`provider/model-id`) and validate the provider
 * is on the supported list.
 *
 * Extracted from llm-adapter.ts (Wave 6d F5).
 */
import { LlmError } from "@assignee/core";
import { LlmProvider, type LlmProviderType } from "../../constants/errors.js";

export type ProviderPrefix = LlmProviderType;

export interface ParsedModel {
  provider: ProviderPrefix;
  modelId: string;
}

/** Default model when ASSIGNEE_MODEL is unset — backward compatible. */
export const DEFAULT_MODEL = `${LlmProvider.BEDROCK}/amazon.nova-lite-v1:0`;

/** Default maxOutputTokens per NFR-15. */
export const DEFAULT_MAX_TOKENS = 1024;

const VALID_PROVIDERS: ReadonlySet<string> = new Set(
  Object.values(LlmProvider),
);

/**
 * Parse a model string like "anthropic/claude-sonnet-4-5" into provider + modelId.
 * Throws LlmError if the format is invalid.
 */
export function parseModelString(modelString: string): ParsedModel {
  const slashIndex = modelString.indexOf("/");
  if (slashIndex === -1) {
    throw new LlmError(
      `Invalid ASSIGNEE_MODEL format: "${modelString}". Expected "provider/model-id" (e.g. "anthropic/claude-sonnet-4-5").`,
    );
  }

  const provider = modelString.slice(0, slashIndex);
  const modelId = modelString.slice(slashIndex + 1);

  if (!modelId) {
    throw new LlmError(
      `Invalid ASSIGNEE_MODEL format: "${modelString}". Model ID is empty after provider prefix.`,
    );
  }

  if (!VALID_PROVIDERS.has(provider)) {
    throw new LlmError(
      `Unsupported provider "${provider}" in ASSIGNEE_MODEL. Supported: ${[...VALID_PROVIDERS].join(", ")}.`,
    );
  }

  return { provider: provider as ProviderPrefix, modelId };
}
