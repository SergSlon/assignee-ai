/**
 * Preflight guard contracts (Wave-6b F2 SOLID refactor).
 *
 * Every preflight check implements the {@link PreflightGuard} interface.
 * The runner ({@link ./runner.ts}) executes guards in registry order and
 * short-circuits on the first FAIL — matching the original monolithic
 * preflight-guard.ts ordering.
 */

import type { StructuredTool } from "@langchain/core/tools";
import type { AgentState } from "../../graph-state.js";

/**
 * Input passed to every preflight guard. Narrowed deliberately — guards
 * should pull only what they need (ISP), not the whole state.
 */
export interface GuardContext {
  readonly state: AgentState;
  readonly tools?: StructuredTool[];
  readonly desiredState: Record<string, unknown>;
}

/**
 * Result returned by a guard.
 *
 * - kind="pass" — guard succeeded, runner advances to the next guard.
 * - kind="fail" — guard found a blocking issue. Runner short-circuits and
 *   the orchestrator returns FAILED with `errorMessage`.
 * - kind="skip" — guard didn't apply (e.g. wrong resource type). Equivalent
 *   to "pass" for the runner; surfaced separately so guards can self-document.
 */
export type GuardResult =
  | { kind: "pass" }
  | { kind: "skip"; reason?: string }
  | { kind: "fail"; errorMessage: string };

/**
 * SOLID interface — every guard in the registry implements this.
 */
export interface PreflightGuard {
  readonly id: string;
  run(ctx: GuardContext): Promise<GuardResult>;
}

export const passResult: GuardResult = { kind: "pass" };
export const skipResult = (reason?: string): GuardResult =>
  reason ? { kind: "skip", reason } : { kind: "skip" };
export const failResult = (errorMessage: string): GuardResult => ({
  kind: "fail",
  errorMessage,
});
