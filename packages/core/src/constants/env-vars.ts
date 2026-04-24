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
  OPERATOR_SESSION_TOKEN: "ASSIGNEE_OPERATOR_SESSION_TOKEN",

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

  // ── Per-node LLM routing (Story 44.1) ─────────────────────────
  ASSIGNEE_LLM_DEFAULT: "ASSIGNEE_LLM_DEFAULT",
  ASSIGNEE_LLM_PLAN_GENERATOR: "ASSIGNEE_LLM_PLAN_GENERATOR",
  ASSIGNEE_LLM_INTENT_PARSER: "ASSIGNEE_LLM_INTENT_PARSER",
  ASSIGNEE_LLM_ADVICE_GENERATOR: "ASSIGNEE_LLM_ADVICE_GENERATOR",
  ASSIGNEE_LLM_WORKLOAD_CLASSIFIER: "ASSIGNEE_LLM_WORKLOAD_CLASSIFIER",

  // ── CLI configuration ─────────────────────────────────────────
  /** @deprecated Use {@link ASSIGNEE_LLM_DEFAULT} instead. Kept for back-compat. */
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

  // ── Distributed tracing / OTLP exporter ──────────────────────
  /**
   * When set, every structured log event is also emitted to the
   * OTLP/HTTP-JSON `/v1/logs` endpoint at this URL (e.g.
   * `http://localhost:4318` for a local OpenTelemetry Collector).
   * Errors and timeouts are swallowed silently — the exporter never
   * blocks or crashes the CLI. @see telemetry/otel-exporter.ts
   */
  ASSIGNEE_OTEL_ENDPOINT: "ASSIGNEE_OTEL_ENDPOINT",
  /**
   * Optional service.name attribute attached to every emitted log
   * record. Defaults to "assignee-cli" when unset.
   */
  ASSIGNEE_OTEL_SERVICE_NAME: "ASSIGNEE_OTEL_SERVICE_NAME",

  // ── Preflight escalation flags (Story 48.3) ──────────────────
  /**
   * Opt-in strict mode: when set to `"1"`, the managed-policy
   * preflight guard treats unknown verification errors as
   * fail-closed instead of the default fail-open+WARN. Useful for
   * SaaS tenants that want to abort on any verification anomaly.
   */
  ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS: "ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS",

  // `ASSIGNEE_ENABLE_REMOTE_MCP` was previously defined here to gate the
  // opt-in remote knowledge MCP server. REMOVED per acquisition-DD L4-S01
  // (2026-04-24): fetch-and-execute of unpinned remote Python was
  // RCE-as-a-feature-flag; the opt-in surface itself was the vulnerability.
  // @see config/mcp-servers.ts for the removal rationale.
} as const;
