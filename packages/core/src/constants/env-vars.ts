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
  /**
   * When set to "1" or "true", suppresses the startup warning that fires
   * when Bedrock is the active provider but no Guardrail has been
   * configured. This is an explicit operator opt-out: the operator
   * acknowledges that LLM-generated content may include PII, harmful
   * topics, or jailbreak responses without a Guardrail in place.
   * @see P018 — acquisition-DD finding, L5 Aiko L5.3 S12
   */
  BEDROCK_GUARDRAIL_DISABLE: "BEDROCK_GUARDRAIL_DISABLE",

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

  // `ASSIGNEE_ENABLE_REMOTE_MCP` was previously defined here to gate the
  // opt-in remote knowledge MCP server. REMOVED per acquisition-DD L4-S01
  // (2026-04-24): fetch-and-execute of unpinned remote Python was
  // RCE-as-a-feature-flag; the opt-in surface itself was the vulnerability.
  // @see config/mcp-servers.ts for the removal rationale.
} as const;
