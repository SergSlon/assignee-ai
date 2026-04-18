/**
 * Shared `StepResult<T>` pattern for MCP tool handler pipelines.
 *
 * Promotes the discriminated-union proven in
 * `tools/destroy-resource/handler-steps.ts` (Epic 53 Story 09) to a
 * reusable utility so plan-resource, apply-plan handler, and
 * bedrock-logging (Epic 54 Wave 3) adopt the same flat early-return
 * shape with zero drift.
 *
 * Shape mirrors destroy-resource/handler-steps.ts EXACTLY:
 * - `kind: "done"` short-circuits the pipeline with a pre-built MCP
 *   response; the orchestrator returns `result.response`.
 * - `kind: "continue"` advances to the next step, optionally carrying
 *   refined context (resolved ARN, AWS client, etc.) in `context`.
 *   Steps that are pure guards use `TContext = void`.
 *
 * Canonical call-site:
 * ```ts
 * const step = await resolveTarget(id, client, region);
 * if (step.kind === "done") return step.response;
 * const resolved = step.context;
 * ```
 */

import type { McpToolResponse } from "../tools/destroy-resource/error-envelope.js";

/** Discriminated step result used by MCP tool handler phases. */
export type StepResult<TContext = void> =
  | { kind: "done"; response: McpToolResponse }
  | { kind: "continue"; context: TContext };

/** Advance to the next step carrying refined context. */
export function continueStep<TContext>(
  context: TContext,
): StepResult<TContext> {
  return { kind: "continue", context };
}

/** Advance to the next step with no context payload (pure guard). */
export function continueVoid(): StepResult<void> {
  return { kind: "continue", context: undefined };
}

/** Short-circuit the pipeline with a pre-built MCP response. */
export function doneStep(response: McpToolResponse): StepResult<never> {
  return { kind: "done", response };
}

/** Type guard — narrows to the `continue` branch. */
export function isContinue<TContext>(
  result: StepResult<TContext>,
): result is { kind: "continue"; context: TContext } {
  return result.kind === "continue";
}

/** Type guard — narrows to the `done` branch. */
export function isDone<TContext>(
  result: StepResult<TContext>,
): result is { kind: "done"; response: McpToolResponse } {
  return result.kind === "done";
}
