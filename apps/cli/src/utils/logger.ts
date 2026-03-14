/**
 * Structured JSON logger for the Assignee.ai CLI.
 * All operational logs are written to stderr as single-line JSON.
 * stdout is reserved for user-facing output (plan boxes, prompts).
 *
 * @see NFR-12 — Structured Logging requirement
 */

export const LOG_ACTIONS = {
  PLAN_STARTED: 'plan_started',
  SCHEMA_FETCHED: 'schema_fetched',
  PLAN_GENERATED: 'plan_generated',
  PLAN_APPROVED: 'plan_approved',
  PLAN_REJECTED: 'plan_rejected_by_user',
  APPLY_STARTED: 'apply_started',
  RESOURCE_PROVISIONING_STARTED: 'resource_provisioning_started',
  PROVISIONING_STATUS_CHECKED: 'provisioning_status_checked',
  STATE_GUARD_SKIPPED: 'state_guard_skipped',
  PRICING_UNAVAILABLE: 'pricing_unavailable',
  APPLY_SUCCEEDED: 'apply_succeeded',
  APPLY_FAILED: 'apply_failed',
} as const

export type LogAction = (typeof LOG_ACTIONS)[keyof typeof LOG_ACTIONS]

export interface LogEvent {
  ts: string
  runId: string
  level: 'info' | 'warn' | 'error'
  action: string
  durationMs?: number
  result?: string
  [key: string]: unknown
}

/**
 * Writes a structured JSON log event to stderr.
 * Each log entry is a single line of JSON for log aggregation compatibility.
 *
 * @param event - The log event to write
 */
export function log(event: LogEvent): void {
  process.stderr.write(JSON.stringify(event) + '\n')
}
