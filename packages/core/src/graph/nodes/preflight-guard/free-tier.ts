/**
 * Free-tier note collection — always non-blocking (Story 7.8 AC #6).
 * Any thrown error is swallowed after a WARN log.
 */
import type { AgentState } from "../../graph-state.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { getFreeTierNote, loadAccountCreatedDate } from "@/utils/free-tier.js";

export type FreeTierNote = ReturnType<typeof getFreeTierNote>;

export function collectFreeTierNote(state: AgentState): FreeTierNote {
  try {
    const accountCreated = loadAccountCreatedDate();
    const note = getFreeTierNote(
      state.resourceType,
      accountCreated,
      state.desiredState as Record<string, unknown> | undefined,
    );
    if (note) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.FREE_TIER_DETECTED,
        extras: { resourceType: state.resourceType, freeTierType: note.type },
      });
    }
    return note;
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.FREE_TIER_DETECTED,
      extras: {
        result: "skipped_on_error",
        resourceType: state.resourceType,
        error: String(err),
      },
    });
    return null;
  }
}
