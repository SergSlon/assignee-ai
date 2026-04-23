/**
 * Shared types for the phase1-gate sub-modules (Story 58-it1-02).
 */

import type { AgentState } from "../../../services/graph.js";

/**
 * Envelope-enrichment payload carried by a Phase-1 `done` result when
 * `success === false`. Epic 98 e98.W5.N4 (B-04 + B-05): lets the CLI
 * wrapper distinguish "provisioning failed at AWS" from "blocked by
 * BP gate" and attach the relevant detail to the JSON envelope.
 *
 * - `kind: "bp_blocked"` + `practiceIds` — Phase-1 BP gate short-
 *   circuit (B-05 closure). `practiceIds` lists the blocking
 *   practice codes (e.g. `["BP-IGW-001"]`) that rejected the plan.
 * - `kind: "apply_failed"` + `errorMessage` — provisioning failed
 *   with a concrete AWS error (B-04 closure). `errorMessage` is
 *   the result-formatter's `errorMessage`, truncated to 500 chars
 *   at the CLI serialisation boundary.
 *
 * Absent on success paths.
 */
export type ApplyFailureDetail =
  | { kind: "bp_blocked"; practiceIds: string[] }
  | { kind: "apply_failed"; errorMessage: string };

/**
 * Result of evaluating the post-Phase-1 state:
 *  - `done`: return this result to the caller (exit early)
 *  - `continue`: proceed to Phase 2 with `phase1State`
 *
 * Epic 98 e98.W5.N4: `result.failure` is the optional typed
 * classification for failure-path done results. Omitted when
 * `success === true` or when the caller has no classification to
 * attach (e.g. Phase-1 CANCELLED / unknown-status terminal).
 */
export type Phase1GateResult =
  | {
      kind: "done";
      result: { success: boolean; failure?: ApplyFailureDetail };
    }
  | { kind: "continue"; phase1State: AgentState };
