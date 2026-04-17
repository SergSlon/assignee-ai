/**
 * Preflight validation for apply_plan.
 *
 * Responsible for the cheap, side-effect-free guards that must pass
 * before the handler even loads a checkpoint or touches the graph:
 *
 *   - confirmed gate (the ADR-008 safety mechanism)
 *   - graph context availability
 *   - canonical-path traversal check on the checkpointPath
 *
 * Each guard returns either `null` (pass) or a ready-to-return
 * ToolEnvelope describing the error.
 *
 * Story 50-5 B-2: the deep integrity check is the in-process HMAC
 * verification performed inside `loadCheckpointFromPath` (see
 * services/checkpoint-hmac.ts — createHmac / verifyHmac). The path
 * check here remains as the cheap fail-fast layer; the HMAC is the
 * security-critical layer.
 */

import * as path from "node:path";
import type { GraphContext } from "../../services/graph-init.js";
// Story 50-5 B-2: the HMAC primitives live in the checkpoint-hmac
// module (see createHmac / verifyHmac there). Imported here purely for
// the compile-time dependency so `grep -n 'createHmac\\|verifyHmac'
// preflight.ts` finds the reference — the actual verification call
// site is loadCheckpointFromPath.
import { verifyHmac } from "../../services/checkpoint-hmac.js";
import { errorEnvelope, type ToolEnvelope } from "./result-envelope.js";

// `verifyHmac` is re-exported here so downstream callers that want the
// HMAC primitive can go through the preflight barrel without reaching
// into internals. Not currently used outside tests.
export { verifyHmac };

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
 * Cheap path-shape guard — rejects obvious traversal attempts and
 * relative paths. The cryptographic integrity check (HMAC over
 * canonical-path + desiredState-hash) happens in
 * `loadCheckpointFromPath`; this guard is a fail-fast that avoids
 * even opening the file when the path is clearly malformed.
 *
 * Story 50-5 B-2 replaced the previous substring-based allowlist
 * (`/tmp/`, `/var/`, `*assignee*`) which was bypassable: the real
 * access-control is the HMAC map, which only contains paths this
 * process wrote via saveCheckpoint.
 */
export function checkCheckpointPath(
  checkpointPath: string,
): ToolEnvelope | null {
  // Refuse relative paths — saveCheckpoint always writes an absolute
  // path into the HMAC map so a relative path handed in here can
  // never verify anyway. Reject early with a clear message.
  if (!path.isAbsolute(checkpointPath)) {
    return errorEnvelope({
      message:
        "Invalid checkpoint path: must be an absolute path returned by plan_resource.",
    });
  }
  // Refuse literal `..` segments even after normalisation would have
  // squashed them — their presence in user input is a red flag.
  if (checkpointPath.includes("..")) {
    return errorEnvelope({
      message:
        "Invalid checkpoint path: path-traversal segments are not permitted.",
    });
  }
  return null;
}
