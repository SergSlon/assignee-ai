/**
 * Best-practices enforcement evaluation.
 *
 * Story 18.10 + Story 41.2 preserved verbatim:
 *   "enforce" (default) — block on any blocking finding.
 *   "warn"              — log only.
 *   "skip"              — no evaluation.
 */
import type { AgentState } from "@/graph/graph-state.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";

export function evaluateBpFindings(state: AgentState): { blocked: boolean } {
  const bpFindings = state.bpFindings ?? [];
  const blockingFindings = bpFindings.filter((f) => f.blocking);
  const bpLevel = state.bpEnforcementLevel ?? "enforce";

  if (bpLevel === "skip") return { blocked: false };

  if (bpLevel === "warn") {
    if (blockingFindings.length > 0) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.BP_EVALUATED,
        extras: {
          enforcement: "warn",
          blockingCount: blockingFindings.length,
          practiceIds: blockingFindings.map((f) => f.practiceId),
        },
      });
    }
    return { blocked: false };
  }

  // enforce
  if (blockingFindings.length > 0) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "warn",
      action: LOG_ACTIONS.BP_EVALUATED,
      extras: {
        blocked: true,
        enforcement: "enforce",
        blockingCount: blockingFindings.length,
        practiceIds: blockingFindings.map((f) => f.practiceId),
      },
    });
    return { blocked: true };
  }
  return { blocked: false };
}
