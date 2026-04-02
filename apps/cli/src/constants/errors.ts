export const ProcessExitCode = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  MCP_STARTUP_FAILED: 10,
} as const;

/**
 * Error code constants — single source of truth for all AssigneeError codes.
 * Use instead of raw string literals like "DESTROY_ERROR".
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const ErrorCode = {
  UNKNOWN: "UNKNOWN",
  DESTROY_ERROR: "DESTROY_ERROR",
  INVALID_SOURCE_DIR: "INVALID_SOURCE_DIR",
  USAGE_ERROR: "USAGE_ERROR",
  MISSING_REQUIRED_FIELDS: "MISSING_REQUIRED_FIELDS",
  MCP_STARTUP_FAILED: "MCP_STARTUP_FAILED",
  LLM_INVALID_RESPONSE: "LLM_INVALID_RESPONSE",
  LLM_RATE_LIMIT: "LLM_RATE_LIMIT",
  BEDROCK_CONNECTIVITY: "BEDROCK_CONNECTIVITY",
  LLM_API_KEY_INVALID: "LLM_API_KEY_INVALID",
  MCP_TOOL_NOT_FOUND: "MCP_TOOL_NOT_FOUND",
  CFN_MCP_UNAVAILABLE: "CFN_MCP_UNAVAILABLE",
  UNSUPPORTED_RESOURCE: "UNSUPPORTED_RESOURCE",
  USER_CANCELLED: "USER_CANCELLED",
  MISSING_INTENT: "MISSING_INTENT",
  NON_INTERACTIVE_NO_YES: "NON_INTERACTIVE_NO_YES",

  // ── Checkpoint errors ────────────────────────────────────────
  CHECKPOINT_ERROR: "CHECKPOINT_ERROR",
  CHECKPOINT_EXPIRED: "CHECKPOINT_EXPIRED",
  CHECKPOINT_INVALID: "CHECKPOINT_INVALID",
  CHECKPOINT_NOT_FOUND: "CHECKPOINT_NOT_FOUND",

  // ── Config parse errors ──────────────────────────────────────
  INVALID_YAML: "INVALID_YAML",

  // ── Credential / config errors ───────────────────────────────
  MISSING_CREDENTIALS: "MISSING_CREDENTIALS",
  MISSING_ACCESS_KEY: "MISSING_ACCESS_KEY",
  MISSING_SECRET_KEY: "MISSING_SECRET_KEY",
  MISSING_REGION: "MISSING_REGION",

  // ── LLM errors ──────────────────────────────────────────────
  LLM_TIMEOUT: "LLM_TIMEOUT",
} as const;

/**
 * LLM provider identifiers used in model string parsing and routing.
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

/**
 * MIME content type constants used in HTTP headers and S3 uploads.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const ContentType = {
  JSON: "application/json",
  JAVASCRIPT: "application/javascript",
  JPEG: "image/jpeg",
} as const;
