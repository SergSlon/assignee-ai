export const ProcessExitCode = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  DOCTOR_WARNINGS: 2,
  POLICY_SAFETY_ABORT: 10,
  MCP_STARTUP_FAILED: 11,
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
 * LLM provider identifiers — re-exported from `@assignee/core/llm`.
 *
 * Lifted in Story 50-4 Wave 5.1 so the in-core LLM model parser /
 * Bedrock region helper can use them without reaching back into the
 * CLI app. This file keeps the export so existing CLI code paths
 * continue to import `LlmProvider` / `LlmProviderType` from
 * `../constants/errors.js`.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export { LlmProvider, type LlmProviderType } from "@assignee/core/llm";

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
