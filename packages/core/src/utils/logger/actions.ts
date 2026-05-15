/**
 * LogAction enum + LogEvent/LogLevel types.
 *
 * Lifted from `apps/cli/src/utils/logger/actions.ts` in Story 50-4
 * Wave 5 Pass A so LlmAdapter (in `@assignee/core/llm`) can emit
 * structured log events without reaching back into the CLI app.
 */

export const LOG_ACTIONS = {
  PLAN_STARTED: "plan_started",
  INTENT_PARSED: "intent_parsed",
  PLAN_COMPLETE: "plan_complete",
  SCHEMA_FETCHED: "schema_fetched",
  GUARDRAIL_DISABLED: "guardrail_disabled",
  PLAN_GENERATED: "plan_generated",
  PREFLIGHT_COMPLETED: "preflight_completed",
  PRICING_UNAVAILABLE: "pricing_unavailable",
  PRICING_TIMEOUT: "pricing_timeout",
  PLAN_APPROVED: "plan_approved",
  PLAN_REJECTED: "plan_rejected_by_user",
  APPLY_STARTED: "apply_started",
  APPLY_COMPLETE: "apply_complete",
  STATE_GUARD_ABORT: "state_guard_abort",
  STATE_GUARD_SKIPPED: "state_guard_skipped",
  STATE_GUARD_SKIPPED_UNRESOLVED_IDENTIFIER:
    "state_guard_skipped_unresolved_identifier",
  RESOURCE_PROVISION_STARTED: "resource_provision_started",
  PROVISIONING_STATUS_CHECKED: "provisioning_status_checked",
  RESULT_FORMATTED: "result_formatted",
  APPLY_SUCCEEDED: "apply_succeeded",
  APPLY_FAILED: "apply_failed",
  CHECKPOINT_SAVED: "checkpoint_saved",
  CHECKPOINT_LOADED: "checkpoint_loaded",
  CHECKPOINT_EXPIRED: "checkpoint_expired",
  PLAN_TO_APPLY_STARTED: "plan_to_apply_started",
  PLAN_TO_APPLY_DECLINED: "plan_to_apply_declined",
  CONFIG_LOADED: "config_loaded",
  ORG_POLICY_FETCHED: "org_policy_fetched",
  SDK_FALLBACK_DISPATCHED: "sdk_fallback_dispatched",
  FREE_TIER_DETECTED: "free_tier_detected",
  BP_EVALUATED: "bp_evaluated",
  BP_EVALUATION_SKIPPED: "bp_evaluation_skipped",
  APPLY_AUTO_APPROVED: "apply_auto_approved",
  IAM_CHECK_SKIPPED: "iam_check_skipped",
  SECURITY_CHECK_SKIPPED: "security_check_skipped",
  MEMORY_WRITE_FAILED: "memory_write_failed",
  OPTION_ELICITED: "option_elicited",
  FIX_APPLIED: "fix_applied",
  PROVISION_LOOP_EXCEEDED: "provision_loop_exceeded",
  MCP_OPTIONAL_INIT_FAILED: "mcp_optional_init_failed",
  ADVICE_GENERATED: "advice_generated",
  ADVICE_SKIPPED: "advice_skipped",
  /**
   * Wave 12 P0: emitted by LlmAdapter after every successful generateText
   * or generateStructured call. Carries the per-call token usage tagged
   * with the calling node's name (callsite). See
   * feedback_token_cost_visibility.
   */
  TOKEN_USAGE: "token_usage",
  /**
   * Wave 12 P0: emitted once at the end of an apply/plan command with
   * the per-callsite breakdown and command total.
   */
  TOKEN_USAGE_SUMMARY: "token_usage_summary",
  /**
   * Architect WARNING #5: bulk-destroy silently drops RGTA-returned types
   * that don't match CloudControl's typeName regex.
   */
  CCAPI_TYPE_DROPPED: "ccapi_type_dropped",
  /**
   * Wave 3 F9 P2-3b: emitted by billing.ts when a Billing MCP tool invocation
   * or JSON parse throws. Now logged at warn level so users running with
   * --verbose can diagnose why cost data is missing.
   */
  BILLING_MCP_QUERY_FAILED: "billing_mcp_query_failed",
  /**
   * M-H-002 (PR #40) / A8 (W-M-008): emitted at warn level when
   * GetBucketPolicy fails with a non-NoSuchBucketPolicy error
   * (e.g. ThrottlingException, AccessDenied) during the compensating
   * bucket-policy merge flow. The attach call returns
   * `{ attached: false, reason }` rather than falling through to a
   * legacy PUT that would clobber existing OAC grants.
   */
  S3_GET_BUCKET_POLICY_FAILED: "s3_get_bucket_policy_failed",
  /**
   * Epic 92 uncluster e92.u.a (D-36): emitted at the start of every
   * `assignee status` invocation so `--verbose` users get the same
   * structured-log envelope that `plan` / `optimize` already provide.
   * Also fires at WARN level when the user passes a stale/unknown
   * runId positional (A-12) so the informative warning lands on the
   * daily log file.
   */
  STATUS_STARTED: "status_started",
  /**
   * Epic 92 uncluster e92.u.a (D-36): emitted at the end of every
   * `assignee status` invocation with `durationMs` + `result:"ok"|"error"`.
   */
  STATUS_COMPLETE: "status_complete",
  /**
   * Epic 98 Wave 2 R1 (B-09/B-10): emitted by `extractRegion` when a
   * region token is resolved from the natural-language intent. Extras
   * carry `{ path: "tail" | "substring", candidate }` so --verbose users
   * can see which code path won when the regex matched both an explicit
   * `region <x>` tail AND a region-shaped substring inside a resource
   * name. Reference: feedback_instrument_before_iterating.md.
   */
  REGION_EXTRACTION: "region_extraction",
  /**
   * Schema service: TTL-expired cache was kept as a stale fallback because
   * the CloudFormation DescribeType API threw. Includes the resource type,
   * error message, cache file path, and a recovery hint. Emitted at WARN
   * level so the event always lands in the rotating daily log file and is
   * visible under `--verbose`.
   */
  SCHEMA_STALE_CACHE_FALLBACK: "schema_stale_cache_fallback",
  /**
   * Story feature-query-intent-classifier: emitted by the query_handler node
   * after the user's query intent has been resolved to a set of managed
   * resources. Distinct from INTENT_PARSED (which fires in intent-parser)
   * so log consumers can distinguish classification from resolution.
   *
   * HIGH 1 fix: replaced the incorrect INTENT_PARSED action that was
   * previously used inside query_handler (wrong callsite semantics).
   */
  QUERY_RESOLVED: "query_resolved",
  /**
   * Wave B-2 (epic-104-demo-dryrun): emitted by
   * `restore-provisions --from-audit-log` when an `apply_resource_created`
   * audit entry is skipped because it lacks a required reconstruction
   * field (resourceArn, timestamp, runId, …) or because the reconstructed
   * ProvisionRecord fails ZodSchema validation. Routed through the
   * shared `log()` helper at WARN level so it is persisted to
   * `~/.assignee/logs/cli-YYYY-MM-DD.jsonl`, exported via OTEL when
   * configured, and visible under `--verbose`.
   *
   * Operators tracking "why did the recovery skip 17 entries?" can grep
   * the daily log file for this action and inspect `extras.reason` /
   * `extras.field` / `extras.index` to triage.
   */
  RESTORE_AUDIT_LOG_SKIP: "restore_audit_log_skip",
  /**
   * Wave C (epic-104-demo-dryrun): emitted by `kms-alias-resolver.ts`
   * when the resolver creates a new default CMK + alias. Carries
   * `extras.keyArn`, `extras.aliasName`, `extras.tagsApplied`. Routed
   * through the shared `log()` helper at INFO level so `--verbose`
   * users see the one-time CMK creation event in the daily log file.
   */
  KMS_ALIAS_CMK_CREATED: "kms_alias_cmk_created",
  /**
   * Wave C (epic-104-demo-dryrun): emitted at WARN level when the
   * resolver finishes the create-path but a non-fatal sub-step failed
   * (typically `EnableKeyRotation`). The CMK + alias still resolved;
   * operator can rerun `aws kms enable-key-rotation` to fix the
   * residual state. Carries `extras.failedStep` and
   * `extras.failureReason`.
   */
  KMS_ALIAS_RESOLVE_PARTIAL: "kms_alias_resolve_partial",
  /**
   * Wave C (epic-104-demo-dryrun): emitted at WARN level when the
   * resolver loses a `CreateAlias` race (concurrent apply created the
   * alias in the same window). Carries `extras.orphanedKeyArn` so the
   * operator can verify the just-created CMK was scheduled for the
   * 7-day pending-deletion window.
   */
  KMS_ALIAS_RACE_LOST: "kms_alias_race_lost",
  /**
   * Pricing SDK bypass (currently AWSDataTransfer): emitted at WARN
   * level when the direct `@aws-sdk/client-pricing` GetProducts call
   * fails — typically because operator credentials are not resolvable
   * (auth error from the SDK provider chain) or because the upstream
   * AWS Pricing API is unhealthy. Carries `extras.serviceCode` and
   * `extras.error`. The caller still returns null and the line item
   * renders as `unavailable`; this log entry exists so operators can
   * diagnose the *why* instead of seeing a silently-blank price.
   */
  PRICING_SDK_BYPASS_FAILED: "pricing_sdk_bypass_failed",
  /**
   * T3-3: emitted at WARN level when `createInvalidation` receives an
   * unexpected SDK error (not AccessDeniedException — those throw
   * PERMISSION_ERROR immediately). Carries `extras.distributionId` and
   * `extras.error` so operators running `--verbose` can grep the NDJSON
   * log to see why an invalidation silently failed instead of bisecting
   * CloudFront logs.
   */
  CLOUDFRONT_INVALIDATION_FAILED: "cloudfront_invalidation_failed",
  /**
   * T3-3: emitted at WARN level when `waitForInvalidation` exits with
   * `timedOut: true`. Carries `extras.distributionId`,
   * `extras.invalidationId`, `extras.timeoutMs`, and `extras.lastStatus`
   * so operators can correlate CloudFront throttling or propagation
   * delays with a specific invalidation request.
   */
  CLOUDFRONT_INVALIDATION_TIMEOUT: "cloudfront_invalidation_timeout",
  /**
   * EPIC-107-2: emitted at WARN level when the existing-resource-discovery
   * port fails to reach AWS (network timeout, missing reader creds, SDK error).
   * Carries `callsite`, `kind`, and `error` extras. The plan continues via
   * the CP-3 advisory fallback — no exception propagates.
   */
  DISCOVERY_FAILURE: "discovery_failure",
} as const;

export type LogAction = (typeof LOG_ACTIONS)[keyof typeof LOG_ACTIONS];

export const LogLevel = {
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

export type LogLevelType = (typeof LogLevel)[keyof typeof LogLevel];

export interface LogEvent {
  ts: string;
  runId: string;
  level: LogLevelType;
  action: LogAction;
  durationMs?: number;
  result?: string;
  extras?: Record<string, unknown>;
}
