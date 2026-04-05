/**
 * Structured JSON logger for the Assignee.ai CLI.
 * All operational logs are written to stderr as single-line JSON.
 * stdout is reserved for user-facing output (plan boxes, prompts).
 *
 * @see NFR-12 — Structured Logging requirement
 * @see Story 9.6 — L2: LogAction exhaustive union; LogEvent index signature removed
 */

import { EnvVar } from "../constants/env-vars.js";

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

/**
 * Returns true when the user has opted-in to verbose / structured log output.
 *
 * Checked (in priority order):
 *   1. `--verbose` CLI flag
 *   2. `ASSIGNEE_VERBOSITY=verbose` environment variable
 *   3. `ASSIGNEE_LOG_LEVEL=debug` environment variable
 *
 * Without an explicit opt-in, structured logs are suppressed so they never
 * leak into stdout/stderr and pollute user-facing output.
 */
function isVerbose(): boolean {
  if (process.argv.includes("--verbose")) return true;
  const verbosity = process.env[EnvVar.ASSIGNEE_VERBOSITY];
  if (verbosity === "verbose") return true;
  const logLevel = process.env[EnvVar.ASSIGNEE_LOG_LEVEL];
  if (logLevel === "debug") return true;
  return false;
}

/**
 * Writes a structured JSON log event to stderr.
 * Each log entry is a single line of JSON for log aggregation compatibility.
 *
 * Logs are only emitted when the user explicitly opts in via `--verbose`,
 * `ASSIGNEE_VERBOSITY=verbose`, or `ASSIGNEE_LOG_LEVEL=debug`.
 * This prevents structured JSON from leaking into terminal output.
 *
 * @param event - The log event to write
 */
export function log(event: LogEvent): void {
  if (!isVerbose()) return;
  process.stderr.write(JSON.stringify(event) + "\n");
}
