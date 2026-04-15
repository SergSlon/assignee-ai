/**
 * Billing MCP structured error logger.
 *
 * Shared helper replacing the four bare `catch {}` blocks that originally
 * lived in billing.ts. Emits a warn-level event so failures surface under
 * --verbose / ASSIGNEE_VERBOSITY=verbose and are persisted to the rotating
 * daily log file (error/warn are always persisted).
 *
 * PRESERVES Wave 4 F3 + Wave 5 F2 — zero bare catches in billing.
 *
 * @see SECURITY-AUDIT H19 — silent error drop.
 */

import { log, LOG_ACTIONS, LogLevel } from "../../utils/logger.js";

/**
 * Log a Billing MCP failure as a structured warn event. The tuple
 * (runId="billing-mcp", action=BILLING_MCP_QUERY_FAILED) is specific to
 * this module's graceful-degradation chain.
 */
export function logBillingMcpFailure(action: string, err: unknown): void {
  log({
    ts: new Date().toISOString(),
    runId: "billing-mcp",
    level: LogLevel.WARN,
    action: LOG_ACTIONS.BILLING_MCP_QUERY_FAILED,
    extras: {
      billingAction: action,
      error: err instanceof Error ? err.message : String(err),
    },
  });
}
