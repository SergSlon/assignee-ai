/**
 * Audit-log helper for the apply_plan MCP tool.
 *
 * Story 54-it1-08 refactor: the tool entrypoint previously emitted
 * four separate 6-field `auditLog()` calls for the different failure
 * outcomes (CheckpointError / ApplyAlreadyActive / BpBlocked /
 * BpEvaluationError) plus a fifth for the terminal graph-execution
 * path. Consolidating them into a single helper with a discriminated
 * outcome keeps the orchestrator readable and prevents a future edit
 * from drifting one of the call-sites.
 *
 * Redaction policy (per feedback_redaction_allowlist_not_denylist):
 *   The underlying `auditLog` enforces the allowlist. This helper
 *   only widens the input type, it never strips or injects fields.
 *
 * Story 50-5 H-3 contract preserved: every call writes the six-field
 * record shape to the persistent JSONL log.
 */

import { auditLog } from "../../utils/audit-log.js";
import { type StepResult, doneStep } from "../../utils/step-result.js";
import { errorEnvelope, type ToolEnvelope } from "./result-envelope.js";

/**
 * Context captured from the checkpoint / caller before the audit
 * record is emitted. `runId` and `resourceType` are empty strings
 * for the early CheckpointError branch where no checkpoint was ever
 * parsed (Story 50-5 H-3 sentinel convention).
 */
export interface ApplyAuditContext {
  runId: string;
  resourceType: string;
  /** Preferred identifier — typically the checkpointPath or a resolved ARN. */
  identifier: string;
}

/**
 * Discriminated outcome for a single apply_plan invocation — one of
 * the exit paths the handler can take.
 *
 * `errorClass` on the failure variant is a short classification
 * string (e.g. "CheckpointError", "BpBlocked", "BpEvaluationError",
 * "ApplyAlreadyActive", "GraphExecutionError") — never a raw message.
 */
export type ApplyOutcome =
  | { kind: "success" }
  | { kind: "failure"; errorClass: string };

/**
 * Emits a single persistent audit record for the apply_plan tool.
 *
 * Centralising the envelope guarantees every outcome writes the same
 * six fields (tool / runId / resourceType / identifier / success /
 * errorClass) with no drift between call-sites.
 */
export async function logApplyAudit(
  ctx: ApplyAuditContext,
  outcome: ApplyOutcome,
): Promise<void> {
  await auditLog({
    tool: "apply_plan",
    runId: ctx.runId,
    resourceType: ctx.resourceType,
    identifier: ctx.identifier,
    success: outcome.kind === "success",
    errorClass: outcome.kind === "success" ? "" : outcome.errorClass,
  });
}

/**
 * Reducer for the four duplicated failure-branch call-sites in the
 * pre-refactor handler (CheckpointError / ApplyAlreadyActive /
 * BpBlocked / BpEvaluationError). Combines the audit write with the
 * `StepResult` done-envelope construction so each phase helper has
 * a single-line failure exit.
 *
 * The caller provides either a ready-built envelope (for the custom
 * BP-blocked payload) or an `{ message, hint? }` shape for the
 * common `errorEnvelope` variant.
 */
export async function failWithAudit(
  ctx: ApplyAuditContext,
  errorClass: string,
  envelope: ToolEnvelope | { message: string; hint?: string },
): Promise<StepResult<never>> {
  await logApplyAudit(ctx, { kind: "failure", errorClass });
  const isToolEnvelope = "content" in envelope;
  const response = isToolEnvelope
    ? envelope
    : errorEnvelope({
        message: envelope.message,
        ...(envelope.hint ? { hint: envelope.hint } : {}),
      });
  return doneStep(response);
}
