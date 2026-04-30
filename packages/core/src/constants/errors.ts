/**
 * Process exit codes, error codes, and content-type constants used across the CLI.
 *
 * Lifted into @assignee/core in Story 50-4 Wave 5 Pass C-2 so error-messages
 * catalogs and the rest of the utility/display tree can share them without
 * the CLI layer becoming a dependency of core utilities.
 */

export const ProcessExitCode = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  DOCTOR_WARNINGS: 2,
  POLICY_SAFETY_ABORT: 10,
  MCP_STARTUP_FAILED: 11,
  /**
   * W3-04 (Epic 100 Round 5): Feature not yet implemented — surface exists
   * but wiring defers to Epic 101. Commands exit with this code when
   * the user invokes a scaffold-only flag (e.g. --target-account)
   * that does not have full backing logic yet.
   */
  NOT_IMPLEMENTED: 12,
  /**
   * W9-S4 (full-audit-2026-04-29 M-β-018): User supplied mutually-exclusive
   * or otherwise invalid flag combination. Scripts should treat this as a
   * usage mistake (distinct from a runtime failure) and surface a help hint.
   */
  USAGE_ERROR: 73,
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
  /**
   * Epic 98 e98.W1.B1 (B-02 BLOCKER): emitted by destroy when the input
   * matches neither the RGTA/IAM name index nor the provision-log
   * primaryIdentifier index. Distinct from DESTROY_ERROR so scripts can
   * distinguish "typo / stale state" from "CCAPI rejected the delete".
   */
  DESTROY_TARGET_NOT_FOUND: "DESTROY_TARGET_NOT_FOUND",
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

  // ── Command-terminal failures (Epic 96 Wave 1 B2) ───────────
  // Emitted by the apply orchestrator when Phase 2 provisioning
  // ends with ExecutionStatus ≠ SUCCESS. Surfaces through the
  // CLI's `--json` error envelope so scripts can distinguish
  // "apply failed at AWS" from generic plumbing errors.
  APPLY_FAILED: "APPLY_FAILED",

  // ── BP-blocked apply (Epic 98 e98.W5.N4 — Epic 97 B-05) ─────
  // Emitted by the apply orchestrator when the Phase-1 BP gate
  // rejects the plan (blocking-severity findings remain after
  // any interactive fix pass). Distinct from APPLY_FAILED so
  // automation can decide whether to (a) rephrase the intent,
  // (b) retry as a compound plan, or (c) run `assignee plan
  // --wizard` for interactive remediation —
  // the `error.detail.practiceIds[]` carries the specific
  // practice IDs (e.g. `BP-IGW-001`) that blocked.
  BP_BLOCKED: "BP_BLOCKED",

  // ── Intent-parser validation failures (Epic 96 Wave 2 R7) ────
  // Emitted by the intent-parser when a `named <x>` span contains
  // non-ASCII characters. Previously surfaced as the generic
  // `PLAN_FAILED` code; A-11 asked for a stable, machine-readable
  // classifier so scripts can distinguish "user typo in resource
  // name" from "pipeline plumbing failure." See
  // `packages/core/src/graph/nodes/intent-parser.ts` ::
  // `extractResourceName` non-ASCII branch.
  INVALID_NAME: "INVALID_NAME",

  // ── Desired-state validation failures (Epic 92 e92.u.c.1) ───
  // Emitted by `validateDesiredStateNode` when plan-time field
  // validation rejects a desired-state value before CloudControl
  // sees it (e.g. invalid S3 BucketName format, SQS queue-name
  // length). Surfaces through the CLI `--output json` envelope as
  // `error.code: "INVALID_DESIRED_STATE"` so CI/automation can
  // distinguish "user config typo caught early" from runtime AWS
  // rejections (`APPLY_FAILED`). Callers that want to branch on
  // validation failures (re-prompt the user, adjust the intent)
  // should match against this code rather than string-matching
  // the human error message.
  INVALID_DESIRED_STATE: "INVALID_DESIRED_STATE",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

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
