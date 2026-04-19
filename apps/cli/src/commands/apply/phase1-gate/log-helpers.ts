/**
 * Log helpers for phase1-gate (Story 58-it1-02 extraction).
 *
 * Centralises the `apply_complete` log record shape so the dispatcher +
 * branch handlers can emit it identically with optional extras / level.
 */

import { log, LOG_ACTIONS, type LogLevelType } from "../../../utils/logger.js";
import type { Phase1Context } from "../phase1-planner.js";

/**
 * Emit the standard `apply_complete` log record. Centralises the 6
 * duplicated log-call shapes across the gate branches.
 */
export function logApplyComplete(
  ctx: Phase1Context,
  result: string,
  extras?: Record<string, unknown>,
  level: LogLevelType = "info",
): void {
  log({
    ts: new Date().toISOString(),
    runId: ctx.runId,
    level,
    action: LOG_ACTIONS.APPLY_COMPLETE,
    durationMs: Date.now() - ctx.startTs,
    result,
    ...(extras ? { extras } : {}),
  });
}
