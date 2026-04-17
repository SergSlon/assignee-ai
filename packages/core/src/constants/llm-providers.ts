/**
 * LLM provider identifiers used in model string parsing and routing.
 *
 * Lifted from `apps/cli/src/constants/errors.ts` in Story 50-4 Wave 5.1
 * so the in-core LLM model parser / Bedrock region helper can use them
 * without reaching back into the CLI app. The CLI's old export becomes
 * a thin re-export of this canonical set.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const LlmProvider = {
  BEDROCK: "bedrock",
  ANTHROPIC: "anthropic",
  OPENAI: "openai",
  GOOGLE: "google",
  OLLAMA: "ollama",
} as const;

export type LlmProviderType = (typeof LlmProvider)[keyof typeof LlmProvider];
