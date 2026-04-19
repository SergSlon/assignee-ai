/**
 * Companion-resource skip check.
 *
 * Some resources in the plan are flagged `provisionable: false` — they are
 * post-provision companions (e.g. S3 bucket-notification configurations that
 * the orchestrator attaches AFTER the primary resource lands, or pure
 * logical groupings used for display only). Those entries must short-circuit
 * the CCAPI pipeline with `executionStatus: SUCCESS` so the graph advances
 * cleanly without a CloudControl round-trip.
 *
 * Extracted from `resource-provisioner.ts` in Story 56-it2-03a (closes L7-003)
 * so the orchestrator is a linear pipeline: state-guard → pre-hooks → CCAPI
 * → result.
 *
 * SRP: this module changes only when the rules for identifying
 * non-provisionable companion resources change.
 */

import { ExecutionStatus } from "@/index.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import type { AgentState } from "../../graph-state.js";

/**
 * Shape of the `resourceQueue[*]` entry this helper inspects. Kept narrow
 * on purpose — the helper only cares about the two fields that drive the
 * skip decision and the log line, so we type exactly those.
 */
export interface CompanionResourceEntry {
  readonly provisionable?: boolean;
  readonly displayName?: string;
}

/**
 * Log and short-circuit for non-provisionable (companion/post-provision)
 * resources. Returns the SUCCESS partial when the current resource is
 * flagged `provisionable: false`; otherwise `null` so the caller
 * continues with the normal CCAPI pipeline.
 */
export function skipIfCompanionResource(
  state: AgentState,
  currentResource: CompanionResourceEntry | undefined,
): Partial<AgentState> | null {
  if (currentResource?.provisionable !== false) return null;
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.SDK_FALLBACK_DISPATCHED,
    extras: {
      resourceType: state.resourceType,
      dispatchPath: "companion-skip",
      message: `Skipping non-provisionable resource: ${currentResource.displayName}`,
    },
  });
  return {
    executionStatus: ExecutionStatus.SUCCESS,
    resourceArn: undefined,
  };
}
