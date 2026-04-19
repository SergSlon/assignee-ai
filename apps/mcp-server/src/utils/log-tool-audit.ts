/**
 * Shared audit-log helper for MCP tool entrypoints.
 *
 * Backlog cleanup story C (post-Epic-55): the apply-plan and
 * destroy-resource tools each shipped a near-identical
 * `logApplyAudit` / `logDestroyAudit` thin wrapper around `auditLog`
 * (Story 53-it1-09 + Story 54-it1-08). The two helpers were ~95%
 * structurally identical — same six-field record shape, same
 * `{ kind: "success" } | { kind: "failure", errorClass }` outcome,
 * differing only in the tool name and how the caller derived
 * `runId` / `identifier` from its own context.
 *
 * This module extracts the common shape into a single
 * `logToolAudit(ctx, outcome)` surface. Both tool-specific helpers
 * become thin adapters: they build the `ToolAuditContext` from their
 * own caller types and forward to this one writer. The on-disk JSONL
 * record shape is unchanged — downstream JSONL parsers see the same
 * `tool` / `runId` / `resourceType` / `identifier` / `success` /
 * `errorClass` / `timestamp` fields they always have.
 *
 * Redaction policy (per feedback_redaction_allowlist_not_denylist):
 *   The underlying `auditLog` enforces the allowlist on the record
 *   shape. This helper only widens the input type; it never strips
 *   or injects fields. Callers that need tool-specific decoration
 *   (apply-plan phase metadata, destroy-resource pre-detach status,
 *   etc.) add it through the optional `extras` field on the outcome,
 *   which is intentionally NOT written to the persistent record
 *   today — callers may attach extras for future structured-logging
 *   sinks (e.g. mcpLog stderr) without leaking through to the
 *   tamper-resistant JSONL audit trail.
 */

import { auditLog } from "./audit-log.js";

/**
 * Common context every audit-emitting tool supplies. Mirrors the
 * stable subset of `AuditRecord` that does not depend on the
 * outcome discrimination.
 *
 * `runId` is required but may be the empty string for tools without
 * a checkpoint (e.g. ad-hoc destroy_resource), matching the Story
 * 50-5 H-3 sentinel convention.
 */
export interface ToolAuditContext {
  /** Tool name as it appears in the JSONL record (e.g. "apply_plan"). */
  tool: string;
  /** Run identifier from the checkpoint or caller. Empty string when unavailable. */
  runId: string;
  /** AWS CloudFormation resource type (e.g. "AWS::S3::Bucket"). */
  resourceType: string;
  /** ARN (preferred) or bare identifier of the resource acted on. */
  identifier: string;
}

/**
 * Discriminated outcome for a single tool invocation. `errorClass` on
 * the failure variant is a short kebab-case or SDK-error-name string
 * (never a raw error message — the redaction allowlist rejects raw
 * messages by construction at the writer layer).
 *
 * `extras` is reserved for tool-specific structured fields that
 * callers may want to attach for non-persistent telemetry (stderr
 * structured logs, future SaaS sink). It is deliberately NOT written
 * to the JSONL audit trail by this helper to preserve the existing
 * six-field record shape — adding new persistent fields requires an
 * explicit schema change to `AuditRecord` in `audit-log.ts`.
 */
export type ToolAuditOutcome =
  | { kind: "success"; extras?: Record<string, unknown> }
  | { kind: "failure"; errorClass: string; extras?: Record<string, unknown> };

/**
 * Emits a single persistent audit record for any MCP tool. Both
 * `logApplyAudit` and `logDestroyAudit` are thin adapters over this
 * function; new audit-emitting tools should adopt the same pattern.
 *
 * The on-disk record contains exactly the six `AuditRecord` fields
 * plus the `timestamp` injected by the underlying writer. Tool-
 * specific extras on the outcome are not persisted (see module
 * comment for rationale).
 */
export async function logToolAudit(
  ctx: ToolAuditContext,
  outcome: ToolAuditOutcome,
): Promise<void> {
  await auditLog({
    tool: ctx.tool,
    runId: ctx.runId,
    resourceType: ctx.resourceType,
    identifier: ctx.identifier,
    success: outcome.kind === "success",
    errorClass: outcome.kind === "success" ? "" : outcome.errorClass,
  });
}
