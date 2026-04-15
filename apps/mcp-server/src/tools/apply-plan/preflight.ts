/**
 * Preflight validation for apply_plan.
 *
 * Responsible for the cheap, side-effect-free guards that must pass
 * before the handler even loads a checkpoint or touches the graph:
 *
 *   - confirmed gate (the ADR-008 safety mechanism)
 *   - graph context availability
 *   - path-traversal check on the checkpointPath
 *
 * Each guard returns either `null` (pass) or a ready-to-return
 * ToolEnvelope describing the error.
 */

import type { GraphContext } from "../../services/graph-init.js";
import { errorEnvelope, type ToolEnvelope } from "./result-envelope.js";

/** Rejects unconfirmed applies — ADR-008 safety gate. */
export function checkConfirmedGate(confirmed: boolean): ToolEnvelope | null {
  if (confirmed) return null;
  return errorEnvelope({
    message:
      "Apply requires explicit confirmation. Set confirmed: true to proceed with provisioning.",
    hint: "This safety mechanism prevents accidental resource creation. Review the plan from plan_resource before confirming.",
  });
}

/** Rejects invocations where the graph context was never injected. */
export function checkGraphContext(
  ctx: GraphContext | undefined,
): ToolEnvelope | null {
  if (ctx) return null;
  return errorEnvelope({
    message:
      "MCP server graph context not initialized. Server must be started with graph initialization.",
  });
}

/**
 * Rejects path-traversal attempts and paths that clearly don't point
 * at an assignee checkpoint directory. Mirrors the CLI guard so MCP
 * clients can't coax the server into reading arbitrary files.
 */
export function checkCheckpointPath(
  checkpointPath: string,
): ToolEnvelope | null {
  const looksLikeTraversal = checkpointPath.includes("..");
  const inAllowedRoot =
    checkpointPath.startsWith("/tmp/") ||
    checkpointPath.startsWith("/var/") ||
    checkpointPath.includes("assignee");
  if (looksLikeTraversal || !inAllowedRoot) {
    return errorEnvelope({
      message:
        "Invalid checkpoint path. Path must be within the assignee checkpoint directory.",
    });
  }
  return null;
}
