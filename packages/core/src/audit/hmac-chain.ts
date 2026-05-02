/**
 * W3-01 (Epic 100 Round 5) — HMAC chain primitive.
 *
 * Each audit-log record is linked to the previous by an HMAC that covers
 * both the prior link's HMAC and the current record's serialised payload.
 * This makes the chain tamper-evident: altering any record or its HMAC
 * breaks every subsequent link.
 *
 * Algorithm: HMAC-SHA256 over `prevHmac + "|" + canonicalJson(record)`.
 * The pipe separator prevents length-extension ambiguity when prevHmac is
 * the sentinel value "GENESIS" for the first record.
 *
 * `canonicalJson` (see below) serialises the record with all object keys
 * sorted alphabetically at every nesting level, producing a byte-stable
 * representation regardless of JS runtime version or object construction
 * order.  Standard `JSON.stringify` iterates keys in insertion order,
 * which differs across V8 versions and when objects are built dynamically,
 * breaking cross-process / cross-platform chain verification.
 *
 * ⚠ CHAIN-FORMAT BREAKING CHANGE (W7-S2 — 2026-04-29):
 *   Audit logs written before this change used `JSON.stringify` (non-
 *   canonical) for HMAC computation. Those HMACs will NOT verify against
 *   this implementation.  To verify a legacy chain, re-compute each HMAC
 *   with `JSON.stringify(record)` using the original key.  For migration
 *   tooling, compare `legacyComputeChainLink(prevHmac, record, key)` (plain
 *   JSON.stringify) against the stored HMAC, then re-sign with
 *   `computeChainLink` once verified.  New chains written after upgrading
 *   use canonical JSON and are forward-compatible across all environments.
 *
 * Key management:
 *   - Production: `ASSIGNEE_AUDIT_KEY` env var (per-tenant secret).
 *   - Dev/CI: persistent key written to `~/.assignee/audit-key` on first
 *     generation (mode 0o600), read on subsequent invocations so HMAC
 *     chains survive process restarts. KMS-backed key management defers
 *     to Epic 101.
 *
 * ⚠ MIGRATION NOTE (W14-S3 — 2026-04-29):
 *   Previously the fallback was a per-process random key (never persisted).
 *   Any audit records written before this change used a key that was
 *   discarded when the process exited — those chains CANNOT be verified
 *   after upgrading (they were already unverifiable across process
 *   boundaries). This is intentional: the fix makes new chains durable;
 *   old chains remain orphaned. Do NOT add migration logic.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";
import { AssigneeError } from "../errors.js";

// ── Canonical JSON serialisation ───────────────────────────────────────

/**
 * Produce a byte-stable JSON representation of `value` by sorting all
 * object keys alphabetically at every nesting level.
 *
 * This is the serialiser used inside `computeChainLink` so that HMAC
 * values are reproducible regardless of JS runtime version, V8 key-
 * enumeration order, or how the record object was originally constructed.
 *
 * Arrays preserve their positional order (only object keys are sorted).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => {
      const v = (value as Record<string, unknown>)[k];
      return JSON.stringify(k) + ":" + canonicalJson(v);
    })
    .join(",");
  return "{" + sorted + "}";
}

// ── Key management ─────────────────────────────────────────────────────

/** Sentinel HMAC value written as the `prevHmac` of the first record. */
export const GENESIS_HMAC = "GENESIS";

/**
 * Minimum acceptable length (in characters) for `ASSIGNEE_AUDIT_KEY`.
 *
 * HMAC-SHA256 uses a 256-bit internal block; any key shorter than 32 bytes
 * (32 ASCII characters, 64 hex characters, or 44 base64 characters) is
 * cryptographically negligible.  32 characters is the bare minimum — a
 * 64-character random hex string (`openssl rand -hex 32`) is recommended
 * for production use.
 */
export const AUDIT_KEY_MIN_LENGTH = 32;

/**
 * Default path for the persistent audit key file.
 *
 * Stored at `~/.assignee/audit-key` with mode 0o600 (owner read+write only).
 * Exported so the `init` wizard and `setup` command can pre-warm the file
 * during workspace initialisation.
 */
export const DEFAULT_AUDIT_KEY_FILE = path.join(
  os.homedir(),
  ".assignee",
  "audit-key",
);

// ── Internal in-process key cache ─────────────────────────────────────
// Avoids redundant filesystem reads on repeated `getAuditKey()` calls
// within the same process lifetime (the file never changes per-process).
let _cachedKey: string | undefined;

// ── Per-process file-mode warning deduplication (PR-019) ──────────────
// Emit the file-mode warning at most once per process, and never on
// Windows where NTFS chmod(600) is a no-op and the warning is misleading.
let _keyModeWarned = false;

/**
 * Resolve the active HMAC audit key with the following priority:
 *
 *   1. `ASSIGNEE_AUDIT_KEY` env var — per-tenant injected secret (SaaS / CI).
 *      If set, the key file is neither read nor written.
 *   2. Persistent key file at `keyFile` (default: `~/.assignee/audit-key`) —
 *      read on every non-env-var call.  File is expected to contain exactly
 *      the key as a single UTF-8 line (no trailing whitespace is stripped).
 *   3. First-use generation — if neither source is present, a 32-byte
 *      cryptographically-random key is generated, written to `keyFile`
 *      with mode `0o600` (exclusive create — TOCTOU-safe: if two processes
 *      race, only the winner writes; the loser retries the read path), and
 *      returned.
 *
 * Fallback (non-writable filesystem): if the file cannot be written (e.g.
 * read-only filesystem, permission denied), `resolveAuditKey` logs a
 * `console.warn` and returns an in-process ephemeral key.  Operators
 * should configure `ASSIGNEE_AUDIT_KEY` on such systems.
 *
 * @param keyFile  - Override the default key-file path (useful in tests).
 * @param config   - Optional `ConfigPort` for reading env vars (defaults to
 *                   `ProcessEnvConfigAdapter`).
 * @returns        - Hex-encoded HMAC key (≥ AUDIT_KEY_MIN_LENGTH chars).
 */
export function resolveAuditKey(
  keyFile: string = DEFAULT_AUDIT_KEY_FILE,
  config?: ConfigPort,
): string {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  const envKey = effectiveConfig.get("ASSIGNEE_AUDIT_KEY");

  // ── Priority 1: env var ────────────────────────────────────────────
  if (envKey && envKey.length > 0) {
    if (envKey.length < AUDIT_KEY_MIN_LENGTH) {
      throw new AssigneeError(
        `ASSIGNEE_AUDIT_KEY must be ≥ ${AUDIT_KEY_MIN_LENGTH} characters; ` +
          `generate one with: openssl rand -hex 32`,
        "AUDIT_KEY_TOO_SHORT",
      );
    }
    return envKey;
  }

  // ── Priority 2: in-process cache (avoids repeated fs reads) ──────
  // Only valid when keyFile is the default (test overrides must bypass).
  if (_cachedKey !== undefined && keyFile === DEFAULT_AUDIT_KEY_FILE) {
    return _cachedKey;
  }

  // ── Priority 3: read existing key file ────────────────────────────
  try {
    if (fs.existsSync(keyFile)) {
      const fileKey = fs.readFileSync(keyFile, "utf8").trim();
      if (fileKey.length >= AUDIT_KEY_MIN_LENGTH) {
        // Warn if the file is not mode 0o600 (advisory; don't fail).
        // Suppressed on Windows (NTFS chmod is a no-op) and after the
        // first emission per process to avoid flooding CI logs (PR-019).
        if (!_keyModeWarned && process.platform !== "win32") {
          try {
            const fileStat = fs.statSync(keyFile);
            if ((fileStat.mode & 0o777) !== 0o600) {
              _keyModeWarned = true;
              process.stderr.write(
                `WARNING: audit key file ${keyFile} has mode ` +
                  `${(fileStat.mode & 0o777).toString(8)} — expected 0600; ` +
                  `run: chmod 600 ${keyFile}\n`,
              );
            }
          } catch {
            // stat failure is non-fatal
          }
        }
        if (keyFile === DEFAULT_AUDIT_KEY_FILE) {
          _cachedKey = fileKey;
        }
        return fileKey;
      }
      // File exists but content is too short — treat as corrupt/missing.
      process.stderr.write(
        `WARNING: audit key file ${keyFile} contains a key shorter than ` +
          `${AUDIT_KEY_MIN_LENGTH} characters — ignoring and regenerating\n`,
      );
    }
  } catch {
    // readFileSync failure handled below as a generate path
  }

  // ── Priority 4: generate, persist, and return ─────────────────────
  const newKey = randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    // flag "wx" = exclusive create — if two processes race, only one wins.
    // The loser gets EEXIST and will read the winner's file on next call.
    fs.writeFileSync(keyFile, newKey, { mode: 0o600, flag: "wx" });
  } catch (err) {
    const errCode = (err as NodeJS.ErrnoException).code;
    if (errCode === "EEXIST") {
      // Another process won the race — read what they wrote.
      try {
        const raceKey = fs.readFileSync(keyFile, "utf8").trim();
        if (raceKey.length >= AUDIT_KEY_MIN_LENGTH) {
          if (keyFile === DEFAULT_AUDIT_KEY_FILE) {
            _cachedKey = raceKey;
          }
          return raceKey;
        }
      } catch {
        // fall through to ephemeral fallback below
      }
    }
    // Non-writable filesystem or other error — fall back to ephemeral key.
    process.stderr.write(
      `WARNING: cannot persist audit key to ${keyFile} (${String(err)}); ` +
        `chain will not be durable across restarts — ` +
        `configure ASSIGNEE_AUDIT_KEY or fix filesystem permissions\n`,
    );
    return newKey; // ephemeral — not cached
  }

  if (keyFile === DEFAULT_AUDIT_KEY_FILE) {
    _cachedKey = newKey;
  }
  return newKey;
}

/**
 * Return the active audit key.
 *
 * Priority:
 *   1. `ASSIGNEE_AUDIT_KEY` env var (per-tenant, persists across restarts).
 *   2. Persistent key file at `~/.assignee/audit-key` (mode 0o600).
 *      Written on first use; read on subsequent invocations — the key is
 *      durable across process restarts.
 *
 * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
 * supply a tenant-scoped key source instead of the process-global
 * `process.env`. When omitted, falls back to a fresh
 * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
 *
 * @deprecated Prefer `resolveAuditKey()` for new call sites; `getAuditKey`
 *   is kept for backwards compatibility and delegates to `resolveAuditKey`.
 */
export function getAuditKey(config?: ConfigPort): string {
  return resolveAuditKey(DEFAULT_AUDIT_KEY_FILE, config);
}

/**
 * @internal Reset the in-process key cache and warning flag — for use in
 * tests only. Resets both `_cachedKey` and `_keyModeWarned` so each test
 * starts with a clean slate.
 */
export function _resetAuditKeyCache(): void {
  _cachedKey = undefined;
  _keyModeWarned = false;
}

// ── Core primitives ────────────────────────────────────────────────────

/**
 * Compute the HMAC for a new chain link.
 *
 * @param prevHmac  - HMAC of the previous record (or `GENESIS_HMAC` for index 0).
 * @param record    - Arbitrary serialisable record object.
 * @param key       - HMAC key (hex string). Defaults to `getAuditKey()`.
 * @returns         - Hex-encoded HMAC-SHA256 digest.
 */
export function computeChainLink(
  prevHmac: string,
  record: unknown,
  key: string = getAuditKey(),
): string {
  const payload = `${prevHmac}|${canonicalJson(record)}`;
  return createHmac("sha256", key).update(payload).digest("hex");
}

/**
 * Verify that a chain link is internally consistent.
 *
 * Re-computes the expected HMAC and compares it to the stored value.
 *
 * @param record    - The record object stored in the entry.
 * @param prevHmac  - The `prevHmac` stored in the same entry.
 * @param storedHmac - The `hmac` field stored in the entry.
 * @param key       - HMAC key (hex string). Defaults to `getAuditKey()`.
 * @returns         - `true` when the link is valid.
 */
export function verifyChainLink(
  record: unknown,
  prevHmac: string,
  storedHmac: string,
  key: string = getAuditKey(),
): boolean {
  const expected = computeChainLink(prevHmac, record, key);
  // Use timingSafeEqual to prevent timing-oracle attacks.
  // Both buffers must have the same byte length; a length mismatch is a
  // guaranteed mismatch (no further comparison needed).
  const expectedBuf = Buffer.from(expected, "utf8");
  const storedBuf = Buffer.from(storedHmac, "utf8");
  if (expectedBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(expectedBuf, storedBuf);
}

// ── Legacy HMAC helpers (W8-S0 — migration tooling for pre-W7 audit logs) ──

/**
 * Compute the HMAC for a pre-W7 chain link.
 *
 * Pre-W7 audit logs used plain `JSON.stringify(record)` (insertion-order,
 * non-canonical) for HMAC computation.  This helper reproduces that
 * byte-for-byte behaviour so that operators can verify old entries before
 * re-signing them with `computeChainLink`.
 *
 * **Migration path**:
 *  1. For each entry in a pre-W7 log, call
 *     `legacyVerifyChainLink(record, prevHmac, storedHmac, key)`.
 *     `true` → the entry was correctly written by the old implementation.
 *  2. Once verified, compute the canonical replacement HMAC with
 *     `computeChainLink(prevHmac, record, key)` and write the new entry.
 *  3. After all entries are re-signed, the chain is fully canonical and
 *     forward-compatible with `verifyChainLink` / `verifyAuditLog`.
 *
 * Do NOT use this function to write new log entries — use `computeChainLink`.
 *
 * @param prevHmac  - HMAC of the previous record (or `GENESIS_HMAC`).
 * @param record    - Record object as stored in the original log entry.
 * @param key       - HMAC key (hex string). Defaults to `getAuditKey()`.
 * @returns         - Hex-encoded HMAC-SHA256 digest matching pre-W7 output.
 */
export function legacyComputeChainLink(
  prevHmac: string,
  record: unknown,
  key: string = getAuditKey(),
): string {
  // Intentionally uses JSON.stringify (insertion-order) — NOT canonicalJson.
  const payload = `${prevHmac}|${JSON.stringify(record)}`;
  return createHmac("sha256", key).update(payload).digest("hex");
}

/**
 * Verify a pre-W7 chain link using the legacy (plain `JSON.stringify`) HMAC.
 *
 * Drop-in mirror of `verifyChainLink` that delegates to
 * `legacyComputeChainLink` instead of `computeChainLink`.  Uses
 * `timingSafeEqual` to prevent timing-oracle attacks, identical to the
 * canonical verifier.
 *
 * @param record     - The record object stored in the entry.
 * @param prevHmac   - The `prevHmac` stored in the same entry.
 * @param storedHmac - The `hmac` field stored in the entry.
 * @param key        - HMAC key (hex string). Defaults to `getAuditKey()`.
 * @returns          - `true` when the legacy link is valid.
 */
export function legacyVerifyChainLink(
  record: unknown,
  prevHmac: string,
  storedHmac: string,
  key: string = getAuditKey(),
): boolean {
  const expected = legacyComputeChainLink(prevHmac, record, key);
  const expectedBuf = Buffer.from(expected, "utf8");
  const storedBuf = Buffer.from(storedHmac, "utf8");
  if (expectedBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(expectedBuf, storedBuf);
}
