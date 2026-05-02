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

// ── SEC-037: legacy fallback opt-in env var ────────────────────────────
/**
 * Name of the environment variable that explicitly opts in to the legacy
 * (pre-W7 plain `JSON.stringify`) HMAC path.
 *
 * SEC-037: `legacyVerifyChainLink` no longer auto-falls-back silently when
 * the canonical verifier fails.  Callers that still need legacy behaviour
 * MUST set `ASSIGNEE_AUDIT_ALLOW_LEGACY=1` (or any truthy value) in the
 * process environment.  Without this opt-in the function throws
 * `LEGACY_HMAC_NOT_ALLOWED` so that operators are forced to make a
 * conscious choice rather than silently accepting a weaker verification.
 */
export const LEGACY_HMAC_OPT_IN_ENV = "ASSIGNEE_AUDIT_ALLOW_LEGACY";

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
// SEC-001: bounded TTL (~5 min) so that long-running MCP servers pick up
// a rotated key file within a predictable window.  After `_cacheExpiresAt`
// the next `resolveAuditKey()` call re-reads from disk.
//
// The cache is only populated when `keyFile === DEFAULT_AUDIT_KEY_FILE`;
// test overrides always bypass it.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _cachedKey: string | undefined;
let _cacheExpiresAt = 0; // epoch ms; 0 means "not set"

// ── Per-process file-mode warning deduplication (PR-019) ──────────────
// Emit the file-mode warning at most once per process, and never on
// Windows where NTFS chmod(600) is a no-op and the warning is misleading.
let _keyModeWarned = false;

// ── SEC-001: SIGHUP handler ────────────────────────────────────────────
// Registers once; subsequent calls to rotateAuditKey / _resetAuditKeyCache
// do NOT re-register — the single handler is sufficient.
let _sighupRegistered = false;

function _registerSighupHandler(): void {
  if (_sighupRegistered) return;
  // SIGHUP is not supported on Windows; skip silently.
  if (process.platform === "win32") return;
  process.on("SIGHUP", () => {
    _cachedKey = undefined;
    _cacheExpiresAt = 0;
    _keyModeWarned = false;
  });
  _sighupRegistered = true;
}

// Register eagerly so MCP servers receive the signal even before the first
// key resolution (e.g. operator sends SIGHUP before any audit activity).
_registerSighupHandler();

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

  // ── Priority 2: in-process TTL cache (avoids repeated fs reads) ─────
  // SEC-001: only serve from cache when not expired.  keyFile must be the
  // default path — test overrides always bypass the cache.
  if (
    _cachedKey !== undefined &&
    keyFile === DEFAULT_AUDIT_KEY_FILE &&
    Date.now() < _cacheExpiresAt
  ) {
    return _cachedKey;
  }

  // ── Priority 3: read existing key file ────────────────────────────
  try {
    if (fs.existsSync(keyFile)) {
      // ── SEC-003/004: reject symlinks and hardlinks ─────────────────
      // Use lstat (does NOT follow symlinks) to detect symlink attacks.
      // Additionally require nlink === 1 to reject hardlink attacks.
      if (process.platform !== "win32") {
        const lstatResult = fs.lstatSync(keyFile);
        if (lstatResult.isSymbolicLink()) {
          throw new AssigneeError(
            `Audit key file ${keyFile} is a symbolic link — refusing to use it. ` +
              `Remove the symlink and place a plain file at that path.`,
            "AUDIT_KEY_SYMLINK",
          );
        }
        if (lstatResult.nlink > 1) {
          throw new AssigneeError(
            `Audit key file ${keyFile} has ${lstatResult.nlink} hard links — ` +
              `refusing to use it. Hard-linked key files may be read by other ` +
              `processes. Create a fresh key file.`,
            "AUDIT_KEY_HARDLINK",
          );
        }
        // ── SEC-005: validate parent-directory mode ──────────────────
        const parentDir = path.dirname(keyFile);
        try {
          const dirStat = fs.statSync(parentDir);
          if ((dirStat.mode & 0o777) !== 0o700) {
            process.stderr.write(
              `WARNING: audit key directory ${parentDir} has mode ` +
                `${(dirStat.mode & 0o777).toString(8)} — expected 0700; ` +
                `run: chmod 700 ${parentDir}\n`,
            );
          }
        } catch {
          // parent-dir stat failure is non-fatal
        }
      }

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
          _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
        }
        return fileKey;
      }
      // File exists but content is too short — treat as corrupt/missing.
      process.stderr.write(
        `WARNING: audit key file ${keyFile} contains a key shorter than ` +
          `${AUDIT_KEY_MIN_LENGTH} characters — ignoring and regenerating\n`,
      );
    }
  } catch (err) {
    // Re-throw security-policy errors (symlink / hardlink) — these are not
    // recoverable via the generate path.
    if (err instanceof AssigneeError) throw err;
    // readFileSync / lstatSync failure handled below as a generate path
  }

  // ── Priority 4: generate, persist, and return ─────────────────────
  const newKey = randomBytes(32).toString("hex");
  try {
    const parentDir = path.dirname(keyFile);
    // Create the parent directory with mode 0o700 (SEC-005).
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    // SEC-003: O_WRONLY|O_CREAT|O_EXCL = exclusive create (TOCTOU-safe:
    // EEXIST if another process wins the race).  On POSIX platforms we
    // additionally OR-in O_NOFOLLOW to refuse following a symlink that was
    // injected between mkdirSync and here.
    // On Windows (no O_NOFOLLOW) we fall back to O_EXCL alone.
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
    // fs.writeFileSync's `flag` option only accepts strings, so we use
    // openSync with the numeric flags directly, then writeSync + closeSync.
    const fd = fs.openSync(keyFile, openFlags, 0o600);
    try {
      fs.writeSync(fd, newKey, 0, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const errCode = (err as NodeJS.ErrnoException).code;
    if (errCode === "EEXIST") {
      // Another process won the race — read what they wrote.
      try {
        const raceKey = fs.readFileSync(keyFile, "utf8").trim();
        if (raceKey.length >= AUDIT_KEY_MIN_LENGTH) {
          if (keyFile === DEFAULT_AUDIT_KEY_FILE) {
            _cachedKey = raceKey;
            _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
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
    _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
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
 * @internal Reset the in-process key cache, TTL, and warning flag — for
 * use in tests only.  Also resets the SIGHUP registration guard so that
 * tests which simulate process-level isolation start with a clean slate.
 *
 * SEC-001: resets `_cacheExpiresAt` so the next `resolveAuditKey()` call
 * unconditionally re-reads from disk (as if the TTL had elapsed).
 */
export function _resetAuditKeyCache(): void {
  _cachedKey = undefined;
  _cacheExpiresAt = 0;
  _keyModeWarned = false;
  // Do NOT reset _sighupRegistered — repeated registrations are harmless
  // but wasteful.  The handler itself clears the cache state variables above.
}

/**
 * Immediately expire the in-process audit-key cache and re-read the key
 * from disk (or the env var) on the next call.
 *
 * SEC-001: Use this when an operator rotates the key file so that
 * long-running MCP servers pick up the new key without a full restart.
 * Prefer sending SIGHUP to the process, which triggers the same reset
 * automatically; call this API when SIGHUP delivery is not possible
 * (e.g. within the same process / during testing).
 *
 * @param keyFile - Optionally re-resolve using a specific key file path
 *   and return the refreshed key.  When omitted the caller is responsible
 *   for calling `resolveAuditKey()` / `getAuditKey()` afterwards.
 * @param config  - Optional `ConfigPort` for reading env vars.
 * @returns       - The freshly resolved key when `keyFile` is provided;
 *                  `undefined` otherwise.
 */
export function rotateAuditKey(
  keyFile?: string,
  config?: ConfigPort,
): string | undefined {
  _cachedKey = undefined;
  _cacheExpiresAt = 0;
  _keyModeWarned = false;
  if (keyFile !== undefined) {
    return resolveAuditKey(keyFile, config);
  }
  return undefined;
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
 * **SEC-037 — explicit opt-in required.**  Callers MUST set the environment
 * variable `ASSIGNEE_AUDIT_ALLOW_LEGACY=1` (or any truthy value) before
 * calling this function.  Without the opt-in it throws
 * `LEGACY_HMAC_NOT_ALLOWED` so that operators are forced to make a
 * conscious choice rather than silently falling back to a weaker verifier.
 *
 * To opt in:
 * ```
 * ASSIGNEE_AUDIT_ALLOW_LEGACY=1 assignee audit verify-legacy …
 * ```
 * Or programmatically (tests / migration scripts only):
 * ```ts
 * process.env[LEGACY_HMAC_OPT_IN_ENV] = "1";
 * ```
 *
 * @param record     - The record object stored in the entry.
 * @param prevHmac   - The `prevHmac` stored in the same entry.
 * @param storedHmac - The `hmac` field stored in the entry.
 * @param key        - HMAC key (hex string). Defaults to `getAuditKey()`.
 * @param config     - Optional `ConfigPort` for reading env vars (defaults
 *                     to `ProcessEnvConfigAdapter`).
 * @returns          - `true` when the legacy link is valid.
 * @throws           - `AssigneeError(LEGACY_HMAC_NOT_ALLOWED)` when the opt-in
 *                     env var is absent.
 */
export function legacyVerifyChainLink(
  record: unknown,
  prevHmac: string,
  storedHmac: string,
  key: string = getAuditKey(),
  config?: ConfigPort,
): boolean {
  // SEC-037: require explicit opt-in to the legacy path.
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  const optIn = effectiveConfig.get(LEGACY_HMAC_OPT_IN_ENV);
  if (!optIn || optIn === "0" || optIn.toLowerCase() === "false") {
    throw new AssigneeError(
      `legacyVerifyChainLink requires an explicit opt-in. ` +
        `Set ${LEGACY_HMAC_OPT_IN_ENV}=1 to enable legacy HMAC verification.`,
      "LEGACY_HMAC_NOT_ALLOWED",
    );
  }

  const expected = legacyComputeChainLink(prevHmac, record, key);
  const expectedBuf = Buffer.from(expected, "utf8");
  const storedBuf = Buffer.from(storedHmac, "utf8");
  if (expectedBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(expectedBuf, storedBuf);
}
