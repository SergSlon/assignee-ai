/**
 * Phase helpers for the apply_plan MCP tool.
 *
 * Story 54-it1-08 refactor: the pre-refactor entrypoint was a 145-LOC
 * inner arrow with four duplicated 6-field `auditLog()` envelopes and
 * deeply nested try/catch blocks. Each discrete phase of the apply
 * pipeline (preflight guards → checkpoint load → concurrency guard
 * → BP re-evaluation → graph execution + audit) now lives here as a
 * focused helper returning a `StepResult` discriminated result, so
 * the orchestrator is a flat sequence of early-return steps.
 *
 * Invariants preserved by this module (cited per project memory):
 * - Active-applies cap behaviour (MAX_ACTIVE_APPLIES = 100) preserved —
 *   `guardConcurrency` is the sole call-site that flips the lock on.
 * - Redaction allowlist preserved — all audit writes route through
 *   `logApplyAudit`, which wraps `auditLog`'s strict allowlist
 *   (feedback_redaction_allowlist_not_denylist).
 * - Wave 2 / L5-H2 `redactSensitive` wrap on the `mcpLogWarn` textSnippet
 *   is owned by `handler.ts::extractAuditIdentifier`; this module does
 *   NOT re-implement that path.
 * - Fail-closed BP evaluation preserved — any thrown error during
 *   evaluation aborts the apply with a BpEvaluationError audit record
 *   and a clear operator hint.
 * - `registerApplyPlan` signature and the MCP tool schema are unchanged.
 */

import { CheckpointError, type PlanCheckpoint } from "@assignee/core";
import type { BPFinding, EvalContext } from "@assignee/best-practices";
import {
  type StepResult,
  continueStep,
  continueVoid,
  doneStep,
} from "../../utils/step-result.js";
import type { GraphContext } from "../../services/graph-init.js";
import { loadCheckpointFromPath } from "../../services/checkpoint.js";
import { isApplyActive, markApplyActive } from "./active-applies.js";
import { evaluateCheckpointBPs } from "./bp-cache.js";
import { runGraphFromCheckpoint } from "./graph-executor.js";
import {
  checkCheckpointPath,
  checkConfirmedGate,
  checkGraphContext,
} from "./preflight.js";
import { errorEnvelope, type ToolEnvelope } from "./result-envelope.js";
import { failWithAudit, logApplyAudit } from "./audit.js";

/** Result of BP re-evaluation that is safe to carry into graph execution. */
export interface BpReevalContext {
  /** Non-blocking findings to seed the graph with (if any). */
  bpFindings?: BPFinding[];
  /** Whether preflight still considers the checkpoint valid. */
  preflightPassed: boolean;
}

/**
 * Shapes the 3-field audit context from a loaded checkpoint plus the
 * invocation's `checkpointPath`. Extracted so the five call-sites that
 * emit an audit record reuse the same (runId, resourceType, identifier)
 * triple without re-typing the same object literal.
 */
function auditContextOf(checkpoint: PlanCheckpoint, checkpointPath: string) {
  return {
    runId: checkpoint.runId,
    resourceType: checkpoint.resourceType,
    identifier: checkpointPath,
  };
}

/**
 * Runs the three cheap preflight guards (confirmed gate, ctx presence,
 * checkpointPath shape). Returns `done` with the first failing
 * envelope, or `continue` (void) to advance to checkpoint load.
 *
 * These guards are side-effect-free and run before any audit record
 * is emitted — a user who never gets past `confirmed: false` produces
 * no JSONL entry, matching the pre-refactor behaviour.
 */
export function runPreflightGuards(
  confirmed: boolean,
  ctx: GraphContext | undefined,
  checkpointPath: string,
): StepResult<void> {
  const confirmedError = checkConfirmedGate(confirmed);
  if (confirmedError) return doneStep(confirmedError);

  const ctxError = checkGraphContext(ctx);
  if (ctxError) return doneStep(ctxError);

  const pathError = checkCheckpointPath(checkpointPath);
  if (pathError) return doneStep(pathError);

  return continueVoid();
}

/**
 * Loads and validates the checkpoint file. On failure, emits a single
 * audit record (runId + resourceType sentinels per Story 50-5 H-3)
 * and returns a `done` step with the error envelope.
 */
export async function loadAndValidateCheckpoint(
  checkpointPath: string,
): Promise<StepResult<PlanCheckpoint>> {
  try {
    const checkpoint = await loadCheckpointFromPath(checkpointPath);
    return continueStep(checkpoint);
  } catch (err) {
    const message =
      err instanceof CheckpointError
        ? err.message
        : `Checkpoint file not found: ${checkpointPath}. Run plan_resource first.`;
    // Story 50-5 H-3: audit the failed load attempt. runId +
    // resourceType may not yet be known here; use "" sentinel.
    return failWithAudit(
      { runId: "", resourceType: "", identifier: checkpointPath },
      err instanceof CheckpointError ? "CheckpointError" : "UnknownError",
      { message },
    );
  }
}

/**
 * Enforces the one-apply-per-checkpoint concurrency guard. If another
 * apply is in flight, emits the ApplyAlreadyActive audit record and
 * returns `done`. Otherwise marks the path active (the orchestrator's
 * `finally` releases it) and advances.
 */
export async function guardConcurrency(
  checkpoint: PlanCheckpoint,
  checkpointPath: string,
): Promise<StepResult<void>> {
  if (isApplyActive(checkpointPath)) {
    return failWithAudit(
      auditContextOf(checkpoint, checkpointPath),
      "ApplyAlreadyActive",
      {
        message:
          "This plan is already being applied. Wait for the current operation to complete.",
      },
    );
  }
  markApplyActive(checkpointPath);
  return continueVoid();
}

/**
 * Story 41.4: BP re-evaluation before provisioning. Catches rules
 * added or modified after the original plan was generated. MCP always
 * enforces BPs — fail-closed on both blocking findings and evaluation
 * errors.
 *
 * Returns `done` with a BP-blocked or BP-eval-error envelope when the
 * apply must be aborted; otherwise advances with the context needed
 * by the graph executor (optional findings + possibly-downgraded
 * preflightPassed).
 */
export async function reevaluateBestPractices(
  checkpoint: PlanCheckpoint,
  checkpointPath: string,
): Promise<StepResult<BpReevalContext>> {
  try {
    const evalContext: EvalContext = {
      resourceType: checkpoint.resourceType,
      desiredState: checkpoint.desiredState,
      userIntent: checkpoint.userIntent,
      patternId: checkpoint.resourcePatternId ?? undefined,
    };
    const result = evaluateCheckpointBPs(evalContext);

    if (result.blocking.length > 0) {
      return failWithAudit(
        auditContextOf(checkpoint, checkpointPath),
        "BpBlocked",
        buildBpBlockedEnvelope(result.blocking),
      );
    }
    return continueStep({
      bpFindings: result.findings,
      preflightPassed: checkpoint.preflightPassed,
    });
  } catch (bpError: unknown) {
    // BP evaluation failure must be fail-closed in enforce mode —
    // block provisioning rather than silently skipping all rules.
    return failWithAudit(
      auditContextOf(checkpoint, checkpointPath),
      "BpEvaluationError",
      {
        message: `BP evaluation failed — cannot verify security compliance. ${bpError instanceof Error ? bpError.message : String(bpError)}`,
        hint: "Check that best-practice rules are accessible. Run plan_resource to generate a fresh plan.",
      },
    );
  }
}

/**
 * Shapes the BP-blocked error envelope. Extracted so
 * `reevaluateBestPractices` stays focused on the control flow.
 */
function buildBpBlockedEnvelope(blocking: BPFinding[]): ToolEnvelope {
  return errorEnvelope({
    message: `BP re-evaluation blocked apply: ${blocking.length} blocking finding(s) detected since the plan was generated.`,
    blockingFindings: blocking.map((f) => ({
      practiceId: f.practiceId,
      title: f.title,
      severity: f.severity,
      message: f.message,
      remediation: f.remediation,
      consequence: f.consequence,
    })),
    hint: "Run plan_resource again to generate a new plan that satisfies current best practices.",
  });
}

/**
 * Drives the graph to completion and emits the single terminal audit
 * record (success OR GraphExecutionError). Returns the MCP envelope
 * directly — no `StepResult` wrapper — because this is the pipeline's
 * terminal phase.
 */
export async function executeAndAudit(
  ctx: GraphContext,
  checkpoint: PlanCheckpoint,
  checkpointPath: string,
  bpCtx: BpReevalContext,
  extractIdentifier: (envelope: ToolEnvelope) => string,
): Promise<ToolEnvelope> {
  const envelope = await runGraphFromCheckpoint({
    ctx,
    checkpoint: {
      runId: checkpoint.runId,
      userIntent: checkpoint.userIntent,
      resourceType: checkpoint.resourceType,
      desiredState: checkpoint.desiredState,
      estimatedMonthlyCost: checkpoint.estimatedMonthlyCost,
      preflightPassed: checkpoint.preflightPassed,
      elicitedOptions: checkpoint.elicitedOptions,
      resourceQueue: checkpoint.resourceQueue,
    },
    bpFindings: bpCtx.bpFindings,
    preflightPassed: bpCtx.preflightPassed,
  });

  // Story 50-5 H-3: mirror the outcome to the persistent audit log.
  const succeeded = envelope.isError !== true;
  await logApplyAudit(
    {
      runId: checkpoint.runId,
      resourceType: checkpoint.resourceType,
      identifier: succeeded
        ? extractIdentifier(envelope) || checkpointPath
        : checkpointPath,
    },
    succeeded
      ? { kind: "success" }
      : { kind: "failure", errorClass: "GraphExecutionError" },
  );
  return envelope;
}
