/**
 * Apply orchestrator — wires Phase 1 → gate → Phase 2 provisioning.
 *
 * Called from the `run` callback handed to runCommand().
 *
 * Epic 96 Wave 1 B2 (A-02): when Phase 2 provisioning ends with
 * `success=false` (ExecutionStatus FAILED / unexpected non-SUCCESS),
 * the orchestrator THROWS an `AssigneeError` so the outer CLI wrapper
 * emits `{ok:false}` + exits non-zero. Prior behaviour quietly returned
 * `{success:false}` and `runCommand` in turn returned normally — the
 * JSON envelope then flipped to `{ok:true}` despite the failure.
 * Phase-1-only terminal paths (CANCELLED / FAILED / bp-blocked) keep
 * the existing Phase1Gate semantics: those return `{success}` through
 * the gate result and the CLI wrapper is responsible for mapping the
 * `success=false` short-circuits to `{ok:false}` via the same throw.
 */

import { stopSpinner } from "../../utils/display.js";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { runProvisioningLoop } from "../../utils/command-runner.js";
import { setApplyBudgetContext } from "../../telemetry/timing.js";
import { loadUserConfig } from "../../config/user-config-loader.js";
import { loadGlobalConfig } from "../../config/load-global-config.js";
import {
  fetchOrgPolicy,
  readAuthToken,
} from "../../config/org-policy-cache.js";
import { buildApplyEnvelopeArn, type PlanCheckpoint } from "@assignee/core";
import type { CommandContext } from "../../utils/command-runner.js";
import type { AgentState } from "../../services/graph.js";
import { runPhase1, type Phase1Deps } from "./phase1-planner.js";
import { handlePhase1Outcome } from "./phase1-gate.js";
import type { ApplyOpts } from "./arg-parser.js";
import type { ApplyFailureDetail } from "./phase1-gate/types.js";

export type OrchestratorCtx = CommandContext;

export interface OrchestratorArgs {
  opts: ApplyOpts;
  intent: string | undefined;
  effectiveIntent: string;
  resolvedCheckpoint: PlanCheckpoint | null;
  resolvedSourceDir: string | undefined;
  sourceFileCount: number | undefined;
}

/**
 * Optional envelope-enrichment fields surfaced alongside `success`. The
 * CLI wrapper reads these in `--json` mode to populate the success
 * envelope with runId / arn / primaryIdentifier / cost.
 *
 * Epic 98 e98.W5.N1 (Epic 97 A-01, B-01): `arn` is `null` for non-taggable
 * CFN constructs that have no standalone AWS ARN (Route / SRTA /
 * VPCGatewayAttachment), and `primaryIdentifier` carries the bare CCAPI
 * id in that case. For ARN-addressable types the full ARN lands in `arn`
 * and `primaryIdentifier` is `null`. For Lambda compound apply, the `arn`
 * field is the full `arn:aws:lambda:...:function:<name>` form of the
 * LAST successfully-provisioned resource in the queue, so
 * `apply --json | jq .arn | xargs destroy` works.
 */
export interface ApplyRunResult {
  success: boolean;
  runId?: string;
  arn?: string | null;
  primaryIdentifier?: string | null;
  cost?: string;
  /**
   * Epic 98 e98.W5.N4 (Epic 97 B-04 + B-05): typed failure classifier
   * so the CLI `--json` wrapper can stamp the right error.code +
   * error.detail on the envelope.
   *   - `{kind: "bp_blocked", practiceIds}` → envelope error.code =
   *     `BP_BLOCKED`, detail.practiceIds carries the blocking IDs.
   *   - `{kind: "apply_failed", errorMessage}` → envelope error.code =
   *     `APPLY_FAILED`, detail.errorMessage carries the concrete
   *     Phase-2 failure from result-formatter (truncated at the CLI
   *     serialisation boundary).
   * Absent on success paths.
   */
  failure?: ApplyFailureDetail;
}

/**
 * End-to-end apply run: load user/org config, run Phase 1, handle the
 * outcome (early-exit or continue), then run Phase 2 provisioning loop.
 *
 * Throws `AssigneeError("APPLY_FAILED")` when Phase 2 ends with
 * `success=false` so the CLI wrapper's error path emits `{ok:false}`
 * + exits non-zero. Phase-1 early-exits still return `{success:false}`
 * without throwing; the wrapper inspects the boolean and rewrites to
 * a thrown AssigneeError when it needs to signal exit 1 through the
 * JSON envelope.
 */
export async function runApply(
  ctx: OrchestratorCtx,
  args: OrchestratorArgs,
): Promise<ApplyRunResult> {
  // Story 7.2: load user config + org policy before graph invocation
  const [userConfig, authToken] = await Promise.all([
    loadUserConfig(),
    readAuthToken(),
  ]);
  const orgConfig = await fetchOrgPolicy(authToken);
  // A2 + A5 (2026-04-08): merge env vars + project yaml + user config
  const resolvedConfig = await loadGlobalConfig(userConfig);

  const graphConfig = {
    configurable: { thread_id: ctx.runId },
    // Compound patterns (up to 22 resources) × ~25 graph nodes each + RDS polling
    recursionLimit: 1000,
  };

  const deps: Phase1Deps = {
    intent: args.intent,
    opts: args.opts,
    resolvedCheckpoint: args.resolvedCheckpoint,
    resolvedSourceDir: args.resolvedSourceDir,
    sourceFileCount: args.sourceFileCount,
    userConfig,
    orgConfig,
    resolvedConfig,
    graphConfig,
  };

  // ── Phase 1: plan + HITL confirmation ─────────────────────────────
  const phase1State = await runPhase1(ctx, deps);
  stopSpinner();

  const gate = await handlePhase1Outcome(
    ctx,
    deps,
    phase1State,
    args.effectiveIntent,
  );
  if (gate.kind === "done") {
    // Phase 1 terminal: CANCELLED (success=true) / FAILED / bp-blocked
    // (success=false). Surface runId so the CLI wrapper can emit it on
    // either path; arn/cost are not yet populated at Phase 1.
    // Epic 98 e98.W5.N4: `failure` (when present) carries the bp_blocked
    // practiceIds so the wrapper can pick BP_BLOCKED + detail in the
    // JSON envelope instead of the generic APPLY_FAILED.
    return { ...gate.result, runId: ctx.runId };
  }

  // ── Phase 2: provision all resources ──────────────────────────────
  const { finalState, success } = await runProvisioningLoop(
    ctx.graph,
    graphConfig,
    gate.phase1State,
  );

  // Epic 98 e98.W5.P2 (Epic 97 A-03 + A-07): inform the timing layer
  // which resourceType this apply targeted so the `total` budget can
  // be overridden for types with AWS-inherent long completion windows
  // (SQS is currently 73-74s vs the 60s rule). Runs BEFORE
  // `persistTimings` fires at the outer runCommand finally, so the
  // budget check sees the override.
  setApplyBudgetContext(finalState.resourceType);

  log({
    ts: new Date().toISOString(),
    runId: ctx.runId,
    level: "info",
    action: LOG_ACTIONS.APPLY_COMPLETE,
    durationMs: Date.now() - ctx.startTs,
    result: finalState.executionStatus,
  });

  // Epic 96 Wave 1 B2: return the enriched result WITHOUT throwing.
  // The outer CLI wrapper inspects `result.success` and converts a
  // Phase-2 failure into a thrown AssigneeError AFTER `runCommand`
  // returns. Throwing here would route the failure through
  // `runCommand`'s catch which re-renders the human error block that
  // `runProvisioningLoop` already wrote to stderr.
  return await enrichResult(finalState, success, ctx.runId);
}

/**
 * Extract runId / arn / primaryIdentifier / cost from the final state
 * for envelope enrichment.
 *
 * Compound apply: the envelope's identifying resource is the LAST
 * successfully-provisioned entry in `completedResources` (the user's
 * "primary" intent target — Lambda for lambda-with-exec-role, CloudFront
 * distribution for static-website, etc.). `finalState.resourceArn` holds
 * that entry's bare CCAPI identifier (preserved for compound-marker
 * substitution — see result-formatter invariants), so we feed that into
 * `buildApplyEnvelopeArn` alongside the entry's `resourceType`.
 *
 * Single apply: same helper with `finalState.resourceType` +
 * `finalState.resourceArn`.
 */
async function enrichResult(
  finalState: AgentState,
  success: boolean,
  fallbackRunId: string,
): Promise<ApplyRunResult> {
  const { resourceType, bareIdentifier } = pickEnvelopeAnchor(finalState);
  const projection = await buildApplyEnvelopeArn(resourceType, bareIdentifier);
  const base: ApplyRunResult = {
    success,
    runId: finalState.runId ?? fallbackRunId,
    arn: projection.arn,
    primaryIdentifier: projection.primaryIdentifier,
    cost: finalState.estimatedMonthlyCost,
  };
  // Epic 98 e98.W5.N4 (B-04): Phase-2 provisioning failed — propagate
  // the concrete `finalState.errorMessage` (e.g. `Invalid id: "igw-xxx"
  // (Service: Ec2, Status Code: 400, ...)`) so the JSON envelope can
  // stamp it on `error.detail.errorMessage` instead of collapsing into
  // the generic "Apply failed: provisioning ended without success."
  if (!success && finalState.errorMessage) {
    base.failure = {
      kind: "apply_failed",
      errorMessage: finalState.errorMessage,
    };
  }
  return base;
}

/**
 * Choose the (resourceType, bareIdentifier) pair the envelope's `arn`
 * field should describe.
 *
 * Compound: the LAST successful entry in `completedResources`
 * (dependency order → the user's primary intent target). Falls back to
 * `finalState.resourceArn` / `finalState.resourceType` if the completed
 * list is empty (defensive; should not happen on a SUCCESS path).
 *
 * Single: `finalState.resourceType` + `finalState.resourceArn`.
 */
function pickEnvelopeAnchor(finalState: AgentState): {
  resourceType: string | undefined;
  bareIdentifier: string | undefined;
} {
  const completed = finalState.completedResources;
  if (completed && completed.length > 0) {
    const last = completed[completed.length - 1];
    if (last && last.resourceArn) {
      return {
        resourceType: last.resourceType,
        bareIdentifier: last.resourceArn,
      };
    }
  }
  return {
    resourceType: finalState.resourceType,
    bareIdentifier: finalState.resourceArn,
  };
}
