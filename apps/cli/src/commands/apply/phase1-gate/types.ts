/**
 * Shared types for the phase1-gate sub-modules (Story 58-it1-02).
 */

import type { AgentState } from "../../../services/graph.js";

/**
 * Result of evaluating the post-Phase-1 state:
 *  - `done`: return this result to the caller (exit early)
 *  - `continue`: proceed to Phase 2 with `phase1State`
 */
export type Phase1GateResult =
  | { kind: "done"; result: { success: boolean } }
  | { kind: "continue"; phase1State: AgentState };
