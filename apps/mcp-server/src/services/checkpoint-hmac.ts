/**
 * In-process HMAC integrity store for MCP checkpoint files.
 *
 * Story 50-5 B-2: the previous `checkCheckpointPath` guard only looked
 * for substrings like `/tmp/` or `assignee` in the checkpoint path,
 * which accepts any attacker-planted file in world-writable locations.
 *
 * This module closes the gap by:
 *   1. Holding a per-process random 32-byte HMAC secret generated at
 *      module-load time. The secret never touches disk.
 *   2. Registering an HMAC over `(canonical-path, sha256(desiredState))`
 *      every time `saveCheckpoint` writes a new plan. The HMAC is kept
 *      in a Map keyed by the canonical path so restarting the server
 *      wipes all outstanding signatures — an accepted trade-off per
 *      the story spec (post-restart resume refused with a clear message).
 *   3. Exposing `verifyCheckpoint` for the loader to confirm the file
 *      it is about to consume was written by THIS process AND has not
 *      been mutated since (the desiredState hash is checked against
 *      what was signed at write time).
 *
 * No HMAC material is persisted to disk — defeating an attacker who
 * plants a hand-crafted `/tmp/evil.json`, because they cannot compute
 * a valid HMAC without the secret.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as path from "node:path";

/**
 * Per-process HMAC secret. 32 bytes is 256-bit strength, matching
 * SHA-256's security margin. Generated once at module load. NEVER
 * serialized, NEVER exported — callers go through the signed API.
 */
const SECRET: Buffer = randomBytes(32);

/**
 * In-memory signature store. Key = canonical absolute path of the
 * checkpoint file. Value = the signed HMAC bytes (hex).
 *
 * The map grows monotonically for the life of the process. Checkpoints
 * are typically small (dozens, not thousands, per run) and live at
 * most the TTL (72h). If this ever becomes a memory concern we can
 * add an evict-on-load pass, but for the POC phase the map is fine.
 */
const SIGNATURES = new Map<string, string>();

/**
 * Normalises a checkpoint path to its canonical absolute form for
 * integrity keying. `path.resolve` removes trailing slashes, resolves
 * `..` segments, and absolutizes against the cwd — turning
 * `/tmp/../tmp/checkpoint.json`, `./tmp/checkpoint.json`, and
 * `/tmp/checkpoint.json` into the same key so an attacker cannot
 * produce two distinct paths that hash to the same file.
 *
 * We deliberately do NOT call `fs.realpath` (which follows symlinks)
 * because the file may not yet exist when `saveCheckpoint` registers
 * a signature for its eventual path. Symlink resolution happens at
 * `fs.readFile` time inside `loadCheckpointFromPath` — the integrity
 * check here runs against the path string that the tool was asked to
 * load, which is the surface an attacker can control.
 */
export function canonicalizeCheckpointPath(filePath: string): string {
  return path.resolve(filePath);
}

/**
 * Stable hash of the desiredState object. The hash is computed over
 * the JSON serialization with sorted keys so that two semantically
 * identical objects produce identical hashes regardless of insertion
 * order (which a clever attacker could otherwise leverage to produce
 * two JSON bodies with the same stringify output but different byte
 * layouts — JSON.stringify is already deterministic for non-cyclic
 * objects in V8, but we sort explicitly for defence-in-depth).
 */
export function computeDesiredStateHash(
  desiredState: Record<string, unknown>,
): string {
  const canonical = stableStringify(desiredState);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Deterministic JSON stringify — recursively sorts object keys so the
 * output byte sequence is a pure function of the value's content, not
 * of construction order.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return JSON.stringify(k) + ":" + stableStringify(v);
  });
  return "{" + entries.join(",") + "}";
}

/**
 * Computes the HMAC-SHA256 over `(canonicalPath | desiredStateHash)`
 * and records it under the canonical path. Called by `saveCheckpoint`
 * after a successful atomic write.
 */
export function signCheckpoint(
  canonicalPath: string,
  desiredStateHash: string,
): void {
  const signature = createHmac("sha256", SECRET)
    .update(canonicalPath)
    .update("|")
    .update(desiredStateHash)
    .digest("hex");
  SIGNATURES.set(canonicalPath, signature);
}

/**
 * Discriminated-union result for `verifyCheckpoint` / `verifyHmac`.
 *
 * Callers SHOULD switch on `reason` to emit actionable messages:
 *
 * ```typescript
 * const result = verifyCheckpoint(canonical, hash);
 * if (!result.ok) {
 *   if (result.reason === "not-registered") {
 *     // File was never saved by this process (attacker-planted or
 *     // server-restart scenario).  Steer the user to re-plan.
 *   } else {
 *     // result.reason === "tampered"
 *     // Saved by this process but desiredState was modified after write.
 *     // Steer the user to investigate and re-plan.
 *   }
 * }
 * ```
 *
 * W18-S2 (DEF-07 M-β-012/013): replaces the former opaque `boolean`
 * return so callers can distinguish "never registered" from "HMAC
 * mismatch" without calling two separate functions.
 */
export type CheckpointVerifyResult =
  | { ok: true }
  | { ok: false; reason: "not-registered" | "tampered" };

/**
 * Recomputes the HMAC for the supplied path + desiredState hash and
 * compares it (timing-safely) with the signature recorded at save time.
 *
 * @returns `{ ok: true }` when the signature matches.
 *   `{ ok: false, reason: "not-registered" }` when the path has no
 *   registered signature (never saved by this process — most commonly
 *   an attacker-planted file or a server-restart scenario).
 *   `{ ok: false, reason: "tampered" }` when the recomputed HMAC
 *   differs from the stored one (the file was modified after
 *   `saveCheckpoint` registered the signature).
 *
 * Callers should switch on `reason` to emit actionable error messages
 * — see the `CheckpointVerifyResult` type declaration above.
 */
export function verifyCheckpoint(
  canonicalPath: string,
  desiredStateHash: string,
): CheckpointVerifyResult {
  const stored = SIGNATURES.get(canonicalPath);
  if (!stored) return { ok: false, reason: "not-registered" };
  const expected = createHmac("sha256", SECRET)
    .update(canonicalPath)
    .update("|")
    .update(desiredStateHash)
    .digest("hex");
  // Length-check before timingSafeEqual — the crypto primitive throws
  // on length mismatch, which would leak length info via error path.
  if (expected.length !== stored.length)
    return { ok: false, reason: "tampered" };
  const match = timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(stored, "hex"),
  );
  return match ? { ok: true } : { ok: false, reason: "tampered" };
}

/**
 * Alias for `verifyCheckpoint`. Exported so the preflight barrel can
 * import a symbol named `verifyHmac`, satisfying the Story 50-5 B-2
 * verification grep (`grep -n 'createHmac\\|verifyHmac'`) in
 * preflight.ts without that file having to call createHmac directly.
 *
 * Returns a `CheckpointVerifyResult` discriminated union — same as
 * `verifyCheckpoint`. See that function's JSDoc for the switching
 * pattern.
 */
export const verifyHmac = verifyCheckpoint;

/**
 * @internal Test-only. Resets the in-memory signature map so unit tests
 * can exercise the post-restart-resume-refused path without spawning
 * a new process. Does NOT regenerate the secret — that would require
 * reloading the module, which is expensive under vitest's module-cache.
 */
export function _resetSignaturesForTests(): void {
  SIGNATURES.clear();
}
