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
  /**
   * When set (any non-empty value), the BP manifest generation script
   * emits a detached GPG signature alongside manifest.json using this
   * local-user identity (key ID, fingerprint, or email). Release-only
   * opt-in — absence keeps the current unsigned-manifest behaviour.
   */
  ASSIGNEE_BP_SIGNING_KEY: "ASSIGNEE_BP_SIGNING_KEY",
  /**
   * When set (any non-empty value), the CLI refuses to load BP rules in
   * enforce mode unless a valid GPG signature is present alongside the
   * manifest. Defense-in-depth beyond on-disk hash verification for users
   * who can guarantee signed releases in their supply chain.
   */
  ASSIGNEE_BP_REQUIRE_SIGNATURE: "ASSIGNEE_BP_REQUIRE_SIGNATURE",
  ASSIGNEE_LOG_DIR: "ASSIGNEE_LOG_DIR",
  ASSIGNEE_LOG_RETENTION_DAYS: "ASSIGNEE_LOG_RETENTION_DAYS",
} as const;
