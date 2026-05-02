/**
 * Preflight validation for apply_plan.
 *
 * Responsible for the cheap, side-effect-free guards that must pass
 * before the handler even loads a checkpoint or touches the graph:
 *
 *   - confirmed gate (the ADR-008 safety mechanism)
 *   - graph context availability
 *   - canonical-path traversal check on the checkpointPath
 *   - realpath symlink check (SEC-020)
 *
 * Each guard returns either `null` (pass) or a ready-to-return
 * ToolEnvelope describing the error.
 *
 * Story 50-5 B-2: the deep integrity check is the in-process HMAC
 * verification performed inside `loadCheckpointFromPath` (see
 * services/checkpoint-hmac.ts — createHmac / verifyHmac). The path
 * check here remains as the cheap fail-fast layer; the HMAC is the
 * security-critical layer.
 *
 * SEC-020: at LOAD time, `checkCheckpointSymlink` resolves the path
 * via `fs.realpath` and compares it to `path.resolve`.  If they
 * differ the request is rejected with `reason: "symlink-detected"` —
 * an attacker who planted a symlink at the checkpoint path cannot
 * substitute attacker-controlled content.
 */

import * as fs from "node:fs";
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

/**
 * Discriminated-union result for `checkCheckpointSymlink`.
 *
 * `ok: true` — the path is a plain file (not a symlink); safe to load.
 * `ok: false, reason: "symlink-detected"` — `fs.realpath` resolved to a
 *   different path than `path.resolve`, indicating a symlink in the chain.
 * `ok: false, reason: "not-found"` — the file does not exist yet (caller
 *   should treat as "not registered" rather than "tampered").
 */
export type CheckpointSymlinkResult =
  | { ok: true }
  | { ok: false; reason: "symlink-detected" | "not-found" };

/**
 * SEC-020: at LOAD time, uses `fs.lstatSync` (does NOT follow symlinks)
 * to detect whether the checkpoint file at `requestedPath` is itself a
 * symlink.  If it is, the request is rejected with
 * `{ ok: false, reason: "symlink-detected" }` so an attacker cannot
 * substitute content by planting a symlink at the expected location.
 *
 * `lstat` is preferred over `realpath` comparison because:
 *  - It directly answers "is this specific file a symlink?" without
 *    being confused by system-level directory symlinks (e.g. `/var →
 *    /private/var` on macOS) that are unrelated to the attack.
 *  - `fs.realpath` on `/var/folders/.../checkpoint.json` returns
 *    `/private/var/folders/.../checkpoint.json` on macOS, causing a
 *    false positive when comparing to `path.resolve(requestedPath)`.
 *
 * The check returns `{ ok: false, reason: "not-found" }` if the file
 * does not yet exist — callers should treat this like "not registered".
 *
 * @param requestedPath  The absolute path passed by the MCP tool caller.
 */
export function checkCheckpointSymlink(
  requestedPath: string,
): CheckpointSymlinkResult {
  const normalized = path.resolve(requestedPath);

  let lstat: fs.Stats;
  try {
    // lstatSync does NOT follow symlinks — it returns info about the
    // symlink itself when the path is a symlink.
    lstat = fs.lstatSync(normalized);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, reason: "not-found" };
    }
    // EACCES or other error — fail closed.
    return { ok: false, reason: "symlink-detected" };
  }

  if (lstat.isSymbolicLink()) {
    return { ok: false, reason: "symlink-detected" };
  }
  return { ok: true };
}
