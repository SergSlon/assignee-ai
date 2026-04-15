/**
 * Graph executor for apply_plan — drives the LangGraph pipeline from
 * a loaded checkpoint to a terminal state, then shapes the final
 * state into the MCP tool response.
 *
 * Kept separate from the handler so the control-flow (confirmed
 * gate, preflight, BP re-eval, locking) stays readable and this
 * module owns the single concern of "run the graph to completion
 * and translate its terminal state".
 */

import {
  ExecutionMode,
  ExecutionStatus,
  BPEnforcementLevel,
  StateField,
} from "@assignee/core";
import type { BPFinding } from "@assignee/best-practices";
import type { GraphContext } from "../../services/graph-init.js";
import {
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from "./result-envelope.js";

/**
 * RDS/ELBv2 can take 5-10 min with many polling cycles; compound
 * patterns multiply this. 10 minutes is a pragmatic ceiling that
 * covers the worst real-world paths without hanging the MCP server.
 */
const APPLY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * RDS provisioning ≈ 8 min at 2 s poll = 240 cycles; compound
 * multi-resource work adds further headroom. 500 keeps us well clear
 * of the graph's default recursion limit.
 */
const GRAPH_RECURSION_LIMIT = 500;

/** Input for runGraphFromCheckpoint — narrow shape of a loaded checkpoint. */
export interface CheckpointInput {
  runId: string;
  userIntent: string;
  resourceType: string;
  desiredState: Record<string, unknown>;
  estimatedMonthlyCost?: unknown;
  preflightPassed: boolean;
  elicitedOptions?: unknown;
  resourceQueue?: unknown;
}

export interface RunGraphArgs {
  ctx: GraphContext;
  checkpoint: CheckpointInput;
  /** BP findings from re-evaluation, if any non-blocking findings were produced. */
  bpFindings?: BPFinding[];
  /** Whether preflight still considers the checkpoint valid after BP re-eval. */
  preflightPassed: boolean;
}

/** Runs the graph from the checkpoint to completion and returns the MCP envelope. */
export async function runGraphFromCheckpoint({
  ctx,
  checkpoint,
  bpFindings,
  preflightPassed,
}: RunGraphArgs): Promise<ToolEnvelope> {
  const runId = checkpoint.runId;
  const config = {
    configurable: { thread_id: `${runId}-mcp-apply` },
    recursionLimit: GRAPH_RECURSION_LIMIT,
  };

  try {
    // Phase 1: inject checkpoint state, auto-approve (MCP has no HITL).
    await ctx.graph.invoke(
      {
        checkpointResumed: true,
        userIntent: checkpoint.userIntent,
        runId,
        executionMode: ExecutionMode.APPLY,
        bpEnforcementLevel: BPEnforcementLevel.ENFORCE,
        startedAt: Date.now(),
        resourceType: checkpoint.resourceType,
        desiredState: checkpoint.desiredState,
        estimatedMonthlyCost: checkpoint.estimatedMonthlyCost,
        preflightPassed,
        elicitedOptions: checkpoint.elicitedOptions,
        resourceQueue: checkpoint.resourceQueue,
        // MCP server bypasses HITL — the `confirmed` gate is the safety mechanism.
        autoApprove: true,
        ...(bpFindings ? { bpFindings } : {}),
      },
      config,
    );

    // Phase 2: provisioning loop with the 10-minute timeout.
    const applyStarted = Date.now();
    while (true) {
      if (Date.now() - applyStarted > APPLY_TIMEOUT_MS) {
        return errorEnvelope({
          message: `Provisioning timed out after ${APPLY_TIMEOUT_MS / 1000}s. Some resources may have been partially created. Use list_managed_resources to check.`,
          status: "TIMEOUT",
        });
      }
      await ctx.graph.invoke(null, config);
      const graphState = await ctx.graph.getState(config);
      if (graphState.next.length === 0) break;
    }

    const finalState = (await ctx.graph.getState(config)).values;
    return shapeTerminalState(finalState, runId);
  } catch (err) {
    return errorEnvelope({
      message: `Provisioning error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/** Translates the graph's terminal state into a MCP tool envelope. */
function shapeTerminalState(
  finalState: Record<string, unknown>,
  runId: string,
): ToolEnvelope {
  const success =
    finalState[StateField.EXECUTION_STATUS] === ExecutionStatus.SUCCESS;

  if (!success) {
    return errorEnvelope({
      message:
        (finalState[StateField.ERROR_MESSAGE] as string) ??
        "Provisioning failed",
      status: finalState[StateField.EXECUTION_STATUS],
    });
  }

  return successEnvelope({
    status: "SUCCESS",
    resourceArn: finalState[StateField.RESOURCE_ARN],
    resourceType: finalState[StateField.RESOURCE_TYPE],
    estimatedMonthlyCost: finalState[StateField.ESTIMATED_MONTHLY_COST],
    securityFindings:
      (finalState[StateField.SECURITY_FINDINGS] as unknown[]) ?? [],
    completedResources:
      (finalState[StateField.COMPLETED_RESOURCES] as unknown[]) ?? [],
    runId,
  });
}
