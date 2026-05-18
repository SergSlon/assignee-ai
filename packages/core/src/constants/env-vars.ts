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
  // M-α-30: session token for STS / ASIA reader keys in MCP subprocess context
  READER_SESSION_TOKEN: "ASSIGNEE_READER_SESSION_TOKEN",

  // ── Auditor credentials ───────────────────────────────────────
  AUDITOR_ACCESS_KEY: "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
  AUDITOR_SECRET_KEY: "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
  // M-α-30: session token for STS / ASIA auditor keys in MCP subprocess context
  AUDITOR_SESSION_TOKEN: "ASSIGNEE_AUDITOR_SESSION_TOKEN",

  // ── AWS standard ──────────────────────────────────────────────
  AWS_REGION: "AWS_REGION",
  AWS_DEFAULT_REGION: "AWS_DEFAULT_REGION",
  AWS_PROFILE: "AWS_PROFILE",

  // ── Bedrock / LLM ────────────────────────────────────────────
  BEDROCK_MODEL_ID: "BEDROCK_MODEL_ID",
  BEDROCK_GUARDRAIL_ID: "BEDROCK_GUARDRAIL_ID",
  BEDROCK_GUARDRAIL_VERSION: "BEDROCK_GUARDRAIL_VERSION",
  /**
   * When set to "1" (ONLY "1"), suppresses the startup warning that fires
   * when Bedrock is the active provider but no Guardrail has been
   * configured. This is an explicit operator opt-out: the operator
   * acknowledges that LLM-generated content may include PII, harmful
   * topics, or jailbreak responses without a Guardrail in place.
   * NOTE: only the value "1" is accepted — "true", "True", "TRUE" are
   * all rejected (parseBoolEnv strict mode). SEC-036.
   * @see P018 — acquisition-DD finding, L5 Aiko L5.3 S12
   */
  BEDROCK_GUARDRAIL_DISABLE: "BEDROCK_GUARDRAIL_DISABLE",

  /**
   * When set to "1", skips the `GuardrailRequiredError` gate that fires
   * when Bedrock is the active provider and BEDROCK_GUARDRAIL_ID is unset.
   * This is also the global opt-out for the one-time non-Bedrock provider
   * guardrail-absence warning (SEC-042). Only the value "1" is accepted.
   * SEC-016, SEC-042.
   */
  ASSIGNEE_ALLOW_NO_GUARDRAIL: "ASSIGNEE_ALLOW_NO_GUARDRAIL",

  // ── LLM routing ───────────────────────────────────────────────
  /**
   * Selects the default LLM model ID for all pipeline nodes. This is the
   * only wired routing env-var today.
   *
   * NOTE: Per-node overrides (PLAN_GENERATOR, INTENT_PARSER,
   * ADVICE_GENERATOR, WORKLOAD_CLASSIFIER) were defined in Story 44.1 but
   * never implemented — the factory sites that would read those vars were
   * never built. Those four constants have been deleted (acquisition-DD
   * finding P038, Epic 100 R9b). If per-node routing is revived, add it
   * as a new story and wire the factory sites before re-adding env-var
   * slots here.
   */
  ASSIGNEE_LLM_DEFAULT: "ASSIGNEE_LLM_DEFAULT",

  // ── CLI configuration ─────────────────────────────────────────
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
  /**
   * Override the minimum audit-log retention floor (default 90 days).
   * Values BELOW 90 are rejected at config-load time with a clear error —
   * the 90-day floor is a hard compliance requirement (ISO 27001 A.12.4 +
   * GDPR Art 30 ROPA). Only values ≥ 90 are accepted.
   * @see P045 — acquisition-DD finding
   * @see docs/explanation/log-retention.md
   */
  ASSIGNEE_AUDIT_RETENTION_DAYS: "ASSIGNEE_AUDIT_RETENTION_DAYS",

  // ── Audit log ─────────────────────────────────────────────────
  /**
   * When set to the string "1", the audit-log HMAC key is sourced from this
   * env var instead of the key file on disk. Intended for SaaS / CI callers
   * that inject a per-tenant secret without touching the filesystem.
   */
  ASSIGNEE_AUDIT_KEY: "ASSIGNEE_AUDIT_KEY",
  /**
   * When set to "0", the post-append fsync calls are skipped for audit-log
   * writes. Improves throughput in test / high-write environments at the cost
   * of kernel-crash durability. NEVER set in production.
   * SEC-043.
   */
  ASSIGNEE_AUDIT_FSYNC: "ASSIGNEE_AUDIT_FSYNC",

  // ── LLM retry ────────────────────────────────────────────────
  /**
   * Maximum number of per-call retry attempts for transient Bedrock
   * throttling errors (ThrottlingException / ServiceUnavailableException /
   * TooManyRequestsException). Integer in [0, 10]. Default: 3.
   * W11-S4.
   */
  ASSIGNEE_LLM_MAX_RETRIES: "ASSIGNEE_LLM_MAX_RETRIES",
  /**
   * Base delay in milliseconds for exponential-backoff retry.
   * Integer in [100, 30000]. Default: 1000.
   * W11-S4.
   */
  ASSIGNEE_LLM_RETRY_BASE_MS: "ASSIGNEE_LLM_RETRY_BASE_MS",
  /**
   * Maximum cumulative ThrottlingException retries (across all concurrent
   * calls) within a 60-second sliding window before fast-failing.
   * Integer in [1, 100]. Default: 20.
   * SEC-028.
   */
  ASSIGNEE_LLM_MAX_GLOBAL_RETRIES: "ASSIGNEE_LLM_MAX_GLOBAL_RETRIES",

  // ── Demo / redaction ──────────────────────────────────────────
  /**
   * When set to "1", AWS account IDs are redacted in CLI output for demo
   * and screen-share scenarios. Does not affect the audit log or LLM prompts
   * (those use the structural redact module independently).
   */
  ASSIGNEE_DEMO_REDACT_ACCOUNT: "ASSIGNEE_DEMO_REDACT_ACCOUNT",

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
  /**
   * When set to "1", the OTEL exporter allows any HTTPS hostname as an
   * endpoint without consulting the built-in or operator-supplied allowlist.
   * Intended for development / custom collector setups only. F026 / SEC-023.
   */
  ASSIGNEE_OTEL_ALLOW_ANY_HOSTNAME: "ASSIGNEE_OTEL_ALLOW_ANY_HOSTNAME",

  // ── Preflight escalation flags (Story 48.3) ──────────────────
  /**
   * Opt-in strict mode: when set to `"1"`, the managed-policy
   * preflight guard treats unknown verification errors as
   * fail-closed instead of the default fail-open+WARN. Useful for
   * SaaS tenants that want to abort on any verification anomaly.
   */
  ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS: "ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS",

  // ── Nightly E2E destroy smoke (W6-03) ────────────────────────
  /**
   * Maximum total USD cost budget for a single nightly E2E destroy smoke
   * run. When the estimated remaining cost of un-provisioned resources
   * would breach this cap, the suite exits early and emits a
   * `budget_exceeded` event to the cost ledger. Default: "5" ($5/day).
   * @see feedback_daily_cost_ceiling
   * @see apps/cli/src/e2e/nightly-destroy-smoke.test.ts
   */
  ASSIGNEE_NIGHTLY_BUDGET_USD: "ASSIGNEE_NIGHTLY_BUDGET_USD",
  /**
   * Directory where nightly E2E cost ledger JSONL files are written.
   * Defaults to `~/.assignee/logs/`. Each file is named
   * `nightly-cost-YYYY-MM-DD.jsonl` and contains one JSON record per
   * provisioned+destroyed resource type.
   */
  ASSIGNEE_NIGHTLY_LEDGER_DIR: "ASSIGNEE_NIGHTLY_LEDGER_DIR",

  // ── OTEL privacy (W6-04) ─────────────────────────────────────
  /**
   * When set to "1", the OTEL exporter includes PII-classified fields
   * in emitted events. When unset or "0", PII fields are stripped
   * at the source-side allowlist before export.
   * @see packages/core/src/telemetry/otel-allowlist.ts
   */
  ASSIGNEE_OTEL_INCLUDE_PII: "ASSIGNEE_OTEL_INCLUDE_PII",
  /**
   * When set to "1", the OTEL exporter allows plaintext HTTP endpoints.
   * By default only HTTPS endpoints are accepted to prevent accidental
   * telemetry exfiltration over an unencrypted channel.
   * Intended for local development / loopback collectors only.
   * @see packages/core/src/telemetry/otel-exporter.ts
   */
  ASSIGNEE_OTEL_ALLOW_HTTP: "ASSIGNEE_OTEL_ALLOW_HTTP",

  /**
   * SEC-023: comma-separated list of acceptable OTLP endpoint hostnames.
   * When set, the OTEL exporter rejects any endpoint whose hostname is not
   * in this list. Default is no allowlist (all hostnames permitted).
   * Example: `ASSIGNEE_OTEL_ENDPOINT_ALLOWLIST=collector.example.com,otel.internal`
   */
  ASSIGNEE_OTEL_ENDPOINT_ALLOWLIST: "ASSIGNEE_OTEL_ENDPOINT_ALLOWLIST",

  // ── RBAC / identity ───────────────────────────────────────────
  /**
   * Override the active RBAC role for the current CLI invocation.
   * Accepted values: "operator" | "reader" | "auditor". Used in tests
   * and SaaS multi-tenant flows to avoid re-reading the OIDC token on
   * every call. @see rbac/role-context.ts
   */
  ASSIGNEE_ROLE: "ASSIGNEE_ROLE",
  /**
   * When set, the CLI skips the built-in OIDC-provider selection dialog
   * in `assignee dev init` and uses the specified adapter name directly.
   * Intended for CI / automated provisioning flows.
   */
  ASSIGNEE_OIDC_ADAPTER: "ASSIGNEE_OIDC_ADAPTER",

  // ── Clarifier ─────────────────────────────────────────────────
  /**
   * When set to "1", the pre-plan clarifying-question step is bypassed.
   * Useful in non-interactive / scripted invocations where an upstream
   * system already ensures the intent is unambiguous.
   * Story 56-it2-04.
   */
  ASSIGNEE_NO_CLARIFIER: "ASSIGNEE_NO_CLARIFIER",

  // ── MCP server ───────────────────────────────────────────────
  /**
   * Maximum number of concurrently running apply operations in the MCP
   * server. Integer. Default behaviour is defined in active-applies.ts.
   */
  ASSIGNEE_MCP_MAX_ACTIVE_APPLIES: "ASSIGNEE_MCP_MAX_ACTIVE_APPLIES",
  /**
   * Override the directory where the MCP server writes its per-session
   * audit log. Defaults to the standard audit-log directory. Used in
   * tests to redirect writes to a temp directory.
   */
  ASSIGNEE_MCP_AUDIT_DIR: "ASSIGNEE_MCP_AUDIT_DIR",

  // ── Intent-routing telemetry (Story 108-B-04) ────────────────────────────
  /**
   * When set to "local", enables the local JSONL telemetry adapter that
   * appends `IntentRoutingEvent` objects to `~/.assignee/telemetry-events.jsonl`.
   * Absent or any other value → no telemetry file is created or modified
   * (L1-F52 opt-in invariant).
   */
  ASSIGNEE_TELEMETRY_ADAPTER: "ASSIGNEE_TELEMETRY_ADAPTER",

  // ── Deprecated aliases ────────────────────────────────────────
  /**
   * @deprecated Alias for ASSIGNEE_LLM_DEFAULT — accepted for backward
   * compatibility. Prefer ASSIGNEE_LLM_DEFAULT for new configurations.
   */
  ASSIGNEE_MODEL: "ASSIGNEE_MODEL",

  // `ASSIGNEE_ENABLE_REMOTE_MCP` was previously defined here to gate the
  // opt-in remote knowledge MCP server. REMOVED per acquisition-DD L4-S01
  // (2026-04-24): fetch-and-execute of unpinned remote Python was
  // RCE-as-a-feature-flag; the opt-in surface itself was the vulnerability.
  // @see config/mcp-servers.ts for the removal rationale.
} as const;
