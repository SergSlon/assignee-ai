/**
 * Audit-log helper for the destroy_resource MCP tool.
 *
 * Story 53-it1-09 refactor: the tool entrypoint previously emitted
 * five separate 6-field auditLog() calls for the different outcomes
 * (NoRequestToken / PollFailure / success / CrossAccountNotFound /
 * NotFoundShortCircuit / generic DestroyError). Consolidating them
 * into a single helper with a discriminated outcome keeps the
 * orchestrator readable and prevents a future edit from drifting
 * one of the call-sites.
 *
 * Redaction policy (per feedback_redaction_allowlist_not_denylist):
 *   The underlying `auditLog` enforces the allowlist. This helper
 *   only widens the input type, it never strips or injects fields.
 */

import { auditLog } from "../../utils/audit-log.js";
import type { ResolvedResource } from "./types.js";

/**
 * Discriminated outcome for a single destroy invocation — one of
 * the exit paths the handler can take once a resource has been
 * successfully resolved.
 *
 * `errorClass` on the failure variant is a short kebab-case or
 * SDK-error-name string (never a raw message).
 */
export type DestroyOutcome =
  | { kind: "success" }
  | { kind: "failure"; errorClass: string };

/**
 * Emits a single persistent audit record for the destroy tool.
 *
 * Accepts the already-resolved resource so call-sites don't repeat
 * the (resourceType, arn) pair. `runId` is unused today because
 * ad-hoc destroys have no checkpoint — keep the field on the record
 * shape so the JSONL schema matches apply_plan.
 */
export async function logDestroyAudit(
  resolved: Pick<ResolvedResource, "arn" | "resourceType">,
  outcome: DestroyOutcome,
): Promise<void> {
  await auditLog({
    tool: "destroy_resource",
    runId: "",
    resourceType: resolved.resourceType,
    identifier: resolved.arn,
    success: outcome.kind === "success",
    errorClass: outcome.kind === "success" ? "" : outcome.errorClass,
  });
}
