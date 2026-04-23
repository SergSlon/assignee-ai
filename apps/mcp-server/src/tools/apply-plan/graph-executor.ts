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
  buildApplyEnvelopeArn,
  type ResourceResult,
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
  /**
   * Story e92.1.d-followup (Epic 89 C-05 closure): partial-apply
   * resume state. When both are non-default the graph re-enters the
   * compound loop at `currentResourceIndex` and the marker-resolver
   * looks up cross-resource references in `completedResources` —
   * avoiding a re-plan of already-provisioned resources. Hydrated
   * to the `ResourceResult` shape by `handler-steps.executeAndAudit`
   * (the on-disk checkpoint persists only `{resourceArn,
   * resourceType}` per entry; the `resourceId` is recovered by
   * zipping against `resourceQueue`).
   */
  currentResourceIndex?: number;
  completedResources?: ResourceResult[];
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

  // Story e92.1.d-followup: forward resume-state into the graph
  // ONLY when the checkpoint carries non-default values. A missing
  // / zero index with no completions maps to a fresh compound plan
  // — we deliberately omit the keys so the graph state shape stays
  // byte-for-byte identical to the pre-fix path on single-resource
  // / pre-Epic-92 checkpoints.
  const hasResume =
    (checkpoint.currentResourceIndex ?? 0) > 0 &&
    (checkpoint.completedResources?.length ?? 0) > 0;
  const resumeProgress = hasResume
    ? {
        currentResourceIndex: checkpoint.currentResourceIndex,
        completedResources: checkpoint.completedResources,
      }
    : {};

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
        ...resumeProgress,
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
    return await shapeTerminalState(finalState, runId);
  } catch (err) {
    return errorEnvelope({
      message: `Provisioning error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Translates the graph's terminal state into a MCP tool envelope.
 *
 * Epic 98 e98.W5.N1 (Epic 97 A-01 + B-01 mirror): `resourceArn` and
 * `primaryIdentifier` now use the same `buildApplyEnvelopeArn`
 * projection the CLI orchestrator uses. For non-taggable constructs
 * (Route / SubnetRouteTableAssociation / VPCGatewayAttachment),
 * `resourceArn: null` + `primaryIdentifier: "<bare id>"`. For
 * ARN-addressable types the full ARN lands in `resourceArn` and
 * `primaryIdentifier` is `null`. Compound apply reports the LAST
 * successfully-provisioned resource as the envelope anchor so
 * automation can thread `resourceArn || primaryIdentifier` into
 * `destroy_resource`.
 */
async function shapeTerminalState(
  finalState: Record<string, unknown>,
  runId: string,
): Promise<ToolEnvelope> {
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

  const completedResources =
    (finalState[StateField.COMPLETED_RESOURCES] as ResourceResult[]) ?? [];
  const anchor = pickEnvelopeAnchor(finalState, completedResources);
  const projection = await buildApplyEnvelopeArn(
    anchor.resourceType,
    anchor.bareIdentifier,
  );

  return successEnvelope({
    status: "SUCCESS",
    resourceArn: projection.arn,
    primaryIdentifier: projection.primaryIdentifier,
    resourceType: anchor.resourceType,
    estimatedMonthlyCost: finalState[StateField.ESTIMATED_MONTHLY_COST],
    securityFindings:
      (finalState[StateField.SECURITY_FINDINGS] as unknown[]) ?? [],
    completedResources,
    runId,
  });
}

/**
 * Pick the (resourceType, bareIdentifier) pair the envelope's
 * resourceArn/primaryIdentifier should describe. Mirrors the CLI
 * orchestrator's `pickEnvelopeAnchor`: LAST completed resource on
 * compound success, terminal state fields otherwise.
 */
function pickEnvelopeAnchor(
  finalState: Record<string, unknown>,
  completedResources: ResourceResult[],
): {
  resourceType: string | undefined;
  bareIdentifier: string | undefined;
} {
  if (completedResources.length > 0) {
    const last = completedResources[completedResources.length - 1];
    if (last && last.resourceArn) {
      return {
        resourceType: last.resourceType,
        bareIdentifier: last.resourceArn,
      };
    }
  }
  return {
    resourceType: finalState[StateField.RESOURCE_TYPE] as string | undefined,
    bareIdentifier: finalState[StateField.RESOURCE_ARN] as string | undefined,
  };
}
