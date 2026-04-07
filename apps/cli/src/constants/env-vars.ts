/**
 * Environment variable name constants — single source of truth.
 * Use instead of raw string literals like "ASSIGNEE_OPERATOR_ACCESS_KEY_ID".
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const EnvVar = {
  // ── Operator credentials ──────────────────────────────────────
  OPERATOR_ACCESS_KEY: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  OPERATOR_SECRET_KEY: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",

  // ── Reader credentials ────────────────────────────────────────
  READER_ACCESS_KEY: "ASSIGNEE_READER_ACCESS_KEY_ID",
  READER_SECRET_KEY: "ASSIGNEE_READER_SECRET_ACCESS_KEY",

  // ── Auditor credentials ───────────────────────────────────────
  AUDITOR_ACCESS_KEY: "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
  AUDITOR_SECRET_KEY: "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",

  // ── AWS standard ──────────────────────────────────────────────
  AWS_REGION: "AWS_REGION",
  AWS_DEFAULT_REGION: "AWS_DEFAULT_REGION",
  AWS_PROFILE: "AWS_PROFILE",

  // ── Bedrock / LLM ────────────────────────────────────────────
  BEDROCK_MODEL_ID: "BEDROCK_MODEL_ID",
  BEDROCK_GUARDRAIL_ID: "BEDROCK_GUARDRAIL_ID",
  BEDROCK_GUARDRAIL_VERSION: "BEDROCK_GUARDRAIL_VERSION",

  // ── CLI configuration ─────────────────────────────────────────
  ASSIGNEE_MODEL: "ASSIGNEE_MODEL",
  ASSIGNEE_VERBOSITY: "ASSIGNEE_VERBOSITY",
  ASSIGNEE_LOG_LEVEL: "ASSIGNEE_LOG_LEVEL",
  ASSIGNEE_RECORD: "ASSIGNEE_RECORD",
  ASSIGNEE_NO_TELEMETRY: "ASSIGNEE_NO_TELEMETRY",
  ASSIGNEE_CONFIG_DIR: "ASSIGNEE_CONFIG_DIR",
  ASSIGNEE_SAAS_URL: "ASSIGNEE_SAAS_URL",
  ASSIGNEE_ORG_POLICY_TTL_MS: "ASSIGNEE_ORG_POLICY_TTL_MS",
  ASSIGNEE_BP_INTEGRITY: "ASSIGNEE_BP_INTEGRITY",
  ASSIGNEE_LOG_DIR: "ASSIGNEE_LOG_DIR",
} as const;
