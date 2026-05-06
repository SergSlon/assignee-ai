/**
 * Phase helpers for the `plan_resource` MCP tool.
 *
 * Story 54-it1-07 refactor: the pre-refactor entrypoint was a ~145 LOC
 * inner arrow with deep nesting and in-line error / checkpoint
 * plumbing. Each discrete phase (context guard → build graph input →
 * invoke → execution-status branch → checkpoint + response) now lives
 * here as a focused helper returning a `StepResult<T>` so the
 * orchestrator becomes a flat sequence of early-return steps.
 *
 * Pattern follows `destroy-resource/handler-steps.ts` (Epic 53) and
 * the promoted `utils/step-result.ts` utility (Story 54-it1-06).
 *
 * Invariants preserved by this module:
 * - Wave 2 hint: `renderSupportedTypesHint('mcp')` is the single source
 *   of truth for the UNSUPPORTED_RESOURCE hint (never re-hardcoded).
 * - Lazy credentials: the ctx guard is the ONLY credential-path check;
 *   it runs before graph.invoke so the expensive graph never boots
 *   without a graph context.
 * - Error envelopes: the `error: true` discriminator and the
 *   `status: <ExecutionStatus>` field shape match the pre-refactor
 *   contract covered by plan-resource.test.ts.
 */

import {
  BPEnforcementLevel,
  ExecutionMode,
  ExecutionStatus,
  StateField,
  renderSupportedTypesHint,
} from "@assignee/core";
import type { GraphContext } from "../../services/graph-init.js";
import {
  MCP_CHECKPOINT_DIR,
  saveCheckpoint,
  serializeCheckpoint,
} from "../../services/checkpoint.js";
import {
  continueStep,
  doneStep,
  type StepResult,
} from "../../utils/step-result.js";
import {
  buildPlanErrorResponse,
  buildPlanSuccessResponse,
  type McpToolResponse,
} from "./error-envelope.js";

/** Error prefix used when plan generation fails with no explicit message. */
export const PLAN_GENERATION_FAILED = "Plan generation failed" as const;

/**
 * Guard that `ctx` was wired before registering the tool. Returned as
 * NOT_READY so the MCP client can back off while the graph bootstraps.
 */
export function guardContext(
  ctx: GraphContext | undefined,
): StepResult<GraphContext> {
  if (!ctx) {
    return doneStep(
      buildPlanErrorResponse({
        message:
          "Graph context not initialized. The MCP server may still be starting up.",
        status: "NOT_READY",
      }),
    );
  }
  return continueStep(ctx);
}

/**
 * Construct the PLAN-mode graph input. Concurrent-safe: region is
 * carried in graph state rather than process.env (Task 3.1).
 */
export function buildInitialGraphState(
  enrichedDescription: string,
  runId: string,
  region: string | undefined,
): Record<string, unknown> {
  return {
    userIntent: enrichedDescription,
    runId,
    executionMode: ExecutionMode.PLAN,
    startedAt: Date.now(),
    noWizard: true, // MCP server never prompts interactively
    bpEnforcementLevel: BPEnforcementLevel.ENFORCE, // Always enforce BPs in MCP
    ...(region ? { awsRegion: region } : {}),
  };
}

/**
 * Prepend the `[env:<env>]` tag to the user intent so the intent
 * parser can apply it as a resource tag (Task 3.2).
 */
export function enrichDescriptionWithEnv(
  description: string,
  env: string | undefined,
): string {
  return env ? `[env:${env}] ${description}` : description;
}

/**
 * Branch on the graph's terminal execution status. FAILED and
 * UNSUPPORTED_RESOURCE short-circuit with a structured error; QUERY_INTENT
 * returns a structured query response (the output was already rendered by
 * the result-formatter node); all other statuses advance to the
 * checkpoint-and-respond step.
 *
 * Story feature-query-intent-classifier: MCP parity for kind=query intents.
 */
export function checkExecutionStatus(
  finalState: Record<string, unknown>,
): StepResult<void> {
  const status = finalState[StateField.EXECUTION_STATUS];

  // QUERY_INTENT: the graph already rendered the output via result-formatter.
  // Return a structured informational response so the MCP client knows the
  // intent was recognised as a query (not a plan). The `queryResult` payload
  // carries the resolved resources if available.
  if (status === ExecutionStatus.QUERY_INTENT) {
    const queryResult = (finalState as Record<string, unknown>)["queryResult"];
    const queryMsg = queryResult
      ? "Query resolved — see queryResult for matched resources."
      : ((finalState[StateField.ERROR_MESSAGE] as string) ??
        "Query intent recognised; use `assignee list` for managed resources.");
    return doneStep(
      buildPlanErrorResponse({
        message: queryMsg,
        status: ExecutionStatus.QUERY_INTENT as string,
        hint: "To list managed resources via MCP, use the `list_managed_resources` tool instead.",
      }),
    );
  }

  if (
    status !== ExecutionStatus.FAILED &&
    status !== ExecutionStatus.UNSUPPORTED_RESOURCE
  ) {
    return continueStep(undefined);
  }
  const message =
    (finalState[StateField.ERROR_MESSAGE] as string) ?? PLAN_GENERATION_FAILED;
  const unsupportedExtras =
    status === ExecutionStatus.UNSUPPORTED_RESOURCE
      ? { hint: renderSupportedTypesHint("mcp") }
      : {};
  return doneStep(
    buildPlanErrorResponse({ message, status, ...unsupportedExtras }),
  );
}

/**
 * Serialize the graph's terminal state into a resumable checkpoint.
 * Extracted so the main orchestrator doesn't juggle half a dozen
 * `StateField` casts inline.
 */
function serializeFinalState(
  finalState: Record<string, unknown>,
  runId: string,
  enrichedDescription: string,
): ReturnType<typeof serializeCheckpoint> {
  return serializeCheckpoint({
    runId,
    userIntent: enrichedDescription,
    resourceType: finalState[StateField.RESOURCE_TYPE] as string | undefined,
    desiredState: finalState[StateField.DESIRED_STATE] as
      | Record<string, unknown>
      | undefined,
    estimatedMonthlyCost: finalState[StateField.ESTIMATED_MONTHLY_COST] as
      | string
      | undefined,
    preflightPassed: finalState[StateField.PREFLIGHT_PASSED] as
      | boolean
      | undefined,
    elicitedOptions: finalState[StateField.ELICITED_OPTIONS] as
      | Record<string, unknown>
      | undefined,
    resourcePattern: finalState[StateField.RESOURCE_PATTERN] as
      | { patternId?: string }
      | undefined,
    resourceQueue: finalState[StateField.RESOURCE_QUEUE] as
      | Array<{
          resourceId: string;
          resourceType: string;
          displayName: string;
        }>
      | undefined,
  });
}

/**
 * Persist the checkpoint to disk and shape the SUCCESS envelope that
 * the MCP client receives. This is the terminal happy-path step.
 */
export async function persistCheckpointAndRespond(
  finalState: Record<string, unknown>,
  runId: string,
  enrichedDescription: string,
): Promise<McpToolResponse> {
  const checkpoint = serializeFinalState(
    finalState,
    runId,
    enrichedDescription,
  );
  const checkpointPath = await saveCheckpoint(checkpoint, MCP_CHECKPOINT_DIR);

  return buildPlanSuccessResponse({
    resourceType: finalState[StateField.RESOURCE_TYPE],
    desiredState: finalState[StateField.DESIRED_STATE],
    estimatedMonthlyCost: finalState[StateField.ESTIMATED_MONTHLY_COST],
    bpFindings: (finalState[StateField.BP_FINDINGS] as unknown[]) ?? [],
    freeTierNote: finalState[StateField.FREE_TIER_NOTE],
    adviceHints: (finalState[StateField.ADVICE_HINTS] as string[]) ?? [],
    checkpointPath,
    runId,
  });
}

/** Top-level catch envelope for unexpected errors during plan generation. */
export function buildUnexpectedErrorResponse(err: unknown): McpToolResponse {
  const message = err instanceof Error ? err.message : String(err);
  return buildPlanErrorResponse({
    message: `Unexpected error during plan generation: ${message}`,
    status: "INTERNAL_ERROR",
  });
}
