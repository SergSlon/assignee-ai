/**
 * In-process HMAC integrity store for MCP checkpoint files.
 *
 * Story 50-5 B-2: the previous `checkCheckpointPath` guard only looked
 * for substrings like `/tmp/` or `assignee` in the checkpoint path,
 * which accepts any attacker-planted file in world-writable locations.
 *
 * This module closes the gap by:
 *   1. Holding a per-process 32-byte HMAC secret. The secret is persisted
 *      to `~/.assignee/checkpoint-hmac-key` (mode 0o600) so MCP server
 *      restarts do not open a re-sign window (SEC-019). On module load the
 *      secret is read from disk; if absent it is generated and written.
 *   2. Registering an HMAC over `(canonical-path, sha256(desiredState))`
 *      every time `saveCheckpoint` writes a new plan. The HMAC is kept
 *      in a Map keyed by the canonical path.
 *   3. Exposing `verifyCheckpoint` for the loader to confirm the file
 *      it is about to consume was written by THIS server AND has not
 *      been mutated since (the desiredState hash is checked against
 *      what was signed at write time).
 *
 * SEC-027: On macOS (APFS — case-insensitive-but-case-preserving) the
 * canonical path is lowercased before HMAC map lookup so that
 * `/path/Foo` and `/path/foo` resolve to the same key, preventing a
 * homoglyph bypass.  The guard is fail-closed: a case variant that was
 * registered under one casing will NOT be found under a different casing,
 * causing a `not-registered` result rather than a false positive.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── SEC-019: persisted HMAC secret ─────────────────────────────────────
/**
 * Default path for the persisted checkpoint HMAC key file.
 *
 * Stored at `~/.assignee/checkpoint-hmac-key` with mode 0o600
 * (owner read+write only).  Mirrors the audit-key pattern in
 * `packages/core/src/audit/hmac-chain.ts`.
 *
 * Exported so tests can inject a temp-dir path without touching the
 * real home directory.
 */
export const DEFAULT_HMAC_KEY_FILE = path.join(
  os.homedir(),
  ".assignee",
  "checkpoint-hmac-key",
);

/**
 * Resolves the 32-byte HMAC secret for checkpoint signing.
 *
 * Priority:
 *  1. Read from `keyFile` if it exists and is a plain file (not symlink).
 *  2. Generate `randomBytes(32)`, write to `keyFile` with
 *     `O_CREAT | O_EXCL | O_NOFOLLOW` (0o600).  EEXIST means another
 *     process won the race — read their file.
 *  3. Fallback: generate an ephemeral Buffer and emit a stderr warning.
 *
 * @param keyFile  Override the default key-file path (useful in tests).
 */
export function resolveHmacSecret(
  keyFile: string = DEFAULT_HMAC_KEY_FILE,
): Buffer {
  // ── Try to read existing file ──────────────────────────────────────
  try {
    if (fs.existsSync(keyFile)) {
      // Reject symlinks to avoid symlink-following attacks.
      if (process.platform !== "win32") {
        const lstat = fs.lstatSync(keyFile);
        if (lstat.isSymbolicLink()) {
          process.stderr.write(
            `WARNING: checkpoint HMAC key file ${keyFile} is a symbolic ` +
              `link — refusing to use it; generating ephemeral secret.\n`,
          );
          return randomBytes(32);
        }
      }
      const hex = fs.readFileSync(keyFile, "utf8").trim();
      if (hex.length === 64) {
        return Buffer.from(hex, "hex");
      }
      // File exists but is malformed — fall through to generate.
      process.stderr.write(
        `WARNING: checkpoint HMAC key file ${keyFile} has unexpected ` +
          `length ${hex.length} (expected 64 hex chars); regenerating.\n`,
      );
    }
  } catch {
    // Unreadable — fall through to generate.
  }

  // ── Generate and persist ─────────────────────────────────────────
  const newKey = randomBytes(32);
  const newHex = newKey.toString("hex");
  try {
    const parentDir = path.dirname(keyFile);
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    // O_WRONLY | O_CREAT | O_EXCL = exclusive create (TOCTOU-safe).
    // OR O_NOFOLLOW on POSIX to reject a symlink injected after mkdir.
    const O_NOFOLLOW_PLATFORM =
      process.platform === "linux"
        ? 0x20000
        : process.platform === "darwin"
          ? 0x100
          : 0; // Windows: no-op
    const openFlags =
      fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      O_NOFOLLOW_PLATFORM;
    const fd = fs.openSync(keyFile, openFlags, 0o600);
    try {
      fs.writeSync(fd, newHex, 0, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return newKey;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Another process won the create race — read their key.
      try {
        const raceHex = fs.readFileSync(keyFile, "utf8").trim();
        if (raceHex.length === 64) {
          return Buffer.from(raceHex, "hex");
        }
      } catch {
        // fall through to ephemeral
      }
    }
    process.stderr.write(
      `WARNING: cannot persist checkpoint HMAC key to ${keyFile} ` +
        `(${String(err)}); using ephemeral secret — ` +
        `post-restart verification will fail.\n`,
    );
    return newKey; // ephemeral
  }
}

/**
 * Per-process HMAC secret. 32 bytes / 256-bit strength, matching
 * SHA-256's security margin.
 *
 * SEC-019: resolved from (or written to) disk on first use so that
 * MCP server restarts use the same secret and can verify checkpoints
 * written before the restart.
 *
 * Lazily initialised (F011): importing this module no longer triggers
 * a disk read/write to ~/.assignee/. Tests that need a clean state can
 * call `_resetSignaturesForTests()` (which also nulls the cached secret)
 * and then inject a temp path via `_setHmacKeyFileForTest()` before the
 * first call that would resolve the secret.
 *
 * NEVER serialized beyond the key file, NEVER exported — callers go
 * through the signed API.
 */
let _secret: Buffer | null = null;
let _hmacKeyFile: string = DEFAULT_HMAC_KEY_FILE;

/** Returns the cached HMAC secret, resolving it on first use. */
function getSecret(): Buffer {
  if (_secret === null) {
    _secret = resolveHmacSecret(_hmacKeyFile);
  }
  return _secret;
}

/**
 * @internal Test-only. Override the key-file path used when the secret is
 * next resolved. Must be called BEFORE any code path that invokes getSecret()
 * (i.e. before saveCheckpoint / signCheckpoint / verifyCheckpoint).
 * Mirrors the `_setHmacKeyFileForTest` name implied by the F011 fix spec.
 */
export function _setHmacKeyFileForTest(keyFile: string): void {
  _hmacKeyFile = keyFile;
}

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
 *
 * SEC-027 (APFS homoglyph): on macOS, APFS is case-insensitive-but-
 * case-preserving. `path.resolve("/tmp/Foo")` and
 * `path.resolve("/tmp/foo")` produce different strings but both open
 * the same inode.  An attacker who saves a checkpoint at `/path/Foo`
 * could attempt to verify-load at `/path/foo`, causing a SIGNATURES
 * map miss (the canonical path differs) and a `not-registered` result
 * — which is the desired fail-closed behaviour, but the mismatch also
 * means a legitimate restart after a case change would fail.
 *
 * Fix: on darwin, lowercase the resolved path before keying so that
 * both spellings of the same APFS path land on the same map slot.
 * The guard is still fail-closed: a lowercase-keyed registration will
 * NOT match a path that hashes differently after lowercasing (e.g.
 * two paths that differ only in non-case characters).
 */
export function canonicalizeCheckpointPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  // SEC-027: lowercase on APFS (macOS) to prevent homoglyph bypass.
  return process.platform === "darwin" ? resolved.toLowerCase() : resolved;
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
  const signature = createHmac("sha256", getSecret())
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
  const expected = createHmac("sha256", getSecret())
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
 * @internal Test-only. Resets the in-memory signature map AND nulls the
 * cached secret so tests that rotate the key file get full isolation.
 * The next call to signCheckpoint / verifyCheckpoint will re-resolve the
 * secret from `_hmacKeyFile` (override via `_setHmacKeyFileForTest` first).
 */
export function _resetSignaturesForTests(): void {
  SIGNATURES.clear();
  _secret = null;
  _hmacKeyFile = DEFAULT_HMAC_KEY_FILE;
}

/**
 * @internal Test-only. Reads (or generates) the HMAC secret from the
 * provided key-file path and returns it as a hex string.  Used by
 * restart-simulation tests that want to verify that two successive
 * `resolveHmacSecret(keyFile)` calls return the same value.
 */
export function _readHmacSecretHexForTests(keyFile: string): string {
  return resolveHmacSecret(keyFile).toString("hex");
}
