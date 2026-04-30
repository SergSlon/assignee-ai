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
