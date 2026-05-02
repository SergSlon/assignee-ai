/**
 * W3-01 + W3-02 (Epic 100 Round 5) — Tamper-evident audit log.
 * SEC-A-4 (2026-04-29) — Scoped tamper-evident claim; rollback threat acknowledged.
 *
 * Write path: each appended record is wrapped with `{record, hmac, prevHmac, index}`
 * and serialised as NDJSON (one JSON line per entry). Writes go through the
 * W4-03 advisory-lock service to prevent concurrent-writer corruption.
 *
 * Read path: `readAuditLog()` returns the entries as an array with full chain
 * metadata so the verifier can walk the chain.
 *
 * **Tamper-evidence scope (SEC-002)**: this module is tamper-evident against
 * attackers who do NOT have read access to the audit key file
 * (~/.assignee/audit-key, 0o600). A same-uid insider with both write access
 * to the log file and read access to the key file can truncate to a chosen
 * entry and resume signing. `guardAuditLogTruncation` protects against
 * accidental truncation but NOT against adversarial truncation by a
 * key-knowing insider. An external anchor (S3 Object Lock, remote
 * append-only sink) is deferred to Epic 101.
 * @see docs/explanation/audit-threat-model.md for the full threat model.
 *
 * Role field (W3-02): every entry carries a `role` field sourced from
 * `getCurrentRole()`. Today that always returns `"operator"` (hardcoded);
 * Epic 101 threads the OIDC-derived role through instead.
 *
 * File mode: 0o600 (owner-only read/write), matching the patterns.json
 * convention used throughout the codebase.
 *
 * Pre-W3 backward compat: lines that do not parse as `AuditEntry` (no
 * `hmac` field) are wrapped as `{ preLegacy: true, raw }` so the verifier
 * can emit a "pre-HMAC region" marker and resume verification at the first
 * HMAC-bearing record.
 *
 * Remote sink (KMS-signed S3 object-lock) defers to Epic 101.
 *
 * @see packages/core/src/locks/file-advisory-lock.ts  (W4-03)
 * @see packages/core/src/audit/hmac-chain.ts           (W3-01)
 * @see packages/core/src/rbac/role-context.ts          (W3-02)
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { computeChainLink, GENESIS_HMAC } from "./hmac-chain.js";
import { getCurrentRole } from "../rbac/role-context.js";
import { defaultFileAdvisoryLock } from "../locks/file-advisory-lock.js";
import {
  MINIMUM_AUDIT_RETENTION_DAYS,
  resolveAuditRetentionDays,
} from "../utils/logger/retention.js";

// ── SEC-043: one-time warning for ASSIGNEE_AUDIT_FSYNC=0 ──────────────
// Emitted at first audit append, not at module load, so that test code
// that never appends sees no noise, and operators who run production
// with fsync disabled see a clear message on the first write.
let _fsyncDisabledWarned = false;

// ── Paths ──────────────────────────────────────────────────────────────

export const DEFAULT_AUDIT_LOG_DIR = path.join(
  os.homedir(),
  ".assignee",
  "audit",
);
export const DEFAULT_AUDIT_LOG_FILE = path.join(
  DEFAULT_AUDIT_LOG_DIR,
  "audit.log",
);

// ── Types ──────────────────────────────────────────────────────────────

/** A well-formed, HMAC-bearing audit-log entry. */
export interface AuditEntry {
  index: number;
  timestamp: string;
  role: string;
  record: unknown;
  prevHmac: string;
  hmac: string;
}

/** A pre-W3 entry that has no HMAC fields. */
export interface LegacyAuditEntry {
  preLegacy: true;
  raw: string;
}

export type AuditLogLine = AuditEntry | LegacyAuditEntry;

// ── Write path ─────────────────────────────────────────────────────────

/**
 * Append a record to the audit log at `logFile`.
 *
 * Acquires the W4-03 advisory lock before reading the tail to determine
 * the correct `(index, prevHmac)` for the new entry.
 */
export async function appendAuditRecord(
  record: unknown,
  logFile: string = DEFAULT_AUDIT_LOG_FILE,
): Promise<AuditEntry> {
  return defaultFileAdvisoryLock.withLock(logFile, async () => {
    // Ensure the directory exists (0o700).
    const dir = path.dirname(logFile);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Read existing entries to determine (index, prevHmac).
    const existing = await readAuditLogRaw(logFile);
    const lastEntry = existing
      .slice()
      .reverse()
      .find((e): e is AuditEntry => !("preLegacy" in e));

    const index = lastEntry ? lastEntry.index + 1 : 0;
    const prevHmac = lastEntry ? lastEntry.hmac : GENESIS_HMAC;

    const entry: AuditEntry = {
      index,
      timestamp: new Date().toISOString(),
      role: getCurrentRole(),
      record,
      prevHmac,
      hmac: computeChainLink(prevHmac, record),
    };

    const line = JSON.stringify(entry) + "\n";

    // Single-call append: the advisory lock held above guarantees exclusive
    // access, so fs.appendFile with O_APPEND semantics is both correct and
    // atomic for our NDJSON format. No temp file is needed or created.
    await fs.appendFile(logFile, line, { mode: 0o600 });

    // SEC-006: Re-enforce 0o600 on every append. `appendFile { mode }` only
    // applies at file CREATION; if an operator accidentally `chmod`ed the log
    // wider (or a pre-existing file already had wider permissions), subsequent
    // appends silently leave it world-readable.  A best-effort chmod after
    // every write closes that window.  Failure is non-fatal: we emit a
    // structured stderr warning and continue so that audit events are never
    // lost due to a permission-relock failure.
    try {
      await fs.chmod(logFile, 0o600);
    } catch (chmodErr) {
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          event: "audit-log-chmod-failed",
          logFile,
          error:
            chmodErr instanceof Error ? chmodErr.message : String(chmodErr),
        }) + "\n",
      );
    }

    // Optional fsync: flush kernel page-cache to disk so a crash between
    // writes does not lose the just-appended entry. Enabled by default;
    // operators can set ASSIGNEE_AUDIT_FSYNC=0 to skip (e.g. in tests or
    // high-throughput environments where the OS flush cadence is acceptable).
    //
    // Two fsyncs are issued:
    //   1. File fsync — ensures the appended bytes reach storage.
    //   2. Directory fsync — ensures the directory entry (inode update, file
    //      size) is also durable. Without this, a kernel crash between the
    //      appendFile and the OS directory-flush can leave the bytes on disk
    //      but invisible to subsequent reads (directory entry not committed).
    // SEC-043: warn once when fsync is disabled so operators don't
    // silently lose audit entries on crash.
    if (process.env["ASSIGNEE_AUDIT_FSYNC"] === "0") {
      if (!_fsyncDisabledWarned) {
        _fsyncDisabledWarned = true;
        process.stderr.write(
          `[audit] WARNING: ASSIGNEE_AUDIT_FSYNC=0 — audit durability is ` +
            `disabled (kernel-crash may lose the last append). ` +
            `Do NOT set this in production.\n`,
        );
      }
    } else {
      // 1. File fsync.
      const fileFd = await fs.open(logFile, "r");
      try {
        await fileFd.sync();
      } finally {
        await fileFd.close();
      }

      // 2. Directory fsync.
      const dirFd = await fs.open(dir, "r");
      try {
        await dirFd.sync();
      } finally {
        await dirFd.close();
      }
    }

    return entry;
  });
}

// ── Read path ──────────────────────────────────────────────────────────

/**
 * Read all lines from the audit log file.
 * Lines without an `hmac` field are returned as `LegacyAuditEntry`.
 */
async function readAuditLogRaw(logFile: string): Promise<Array<AuditLogLine>> {
  let content: string;
  try {
    content = await fs.readFile(logFile, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line): AuditLogLine => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "hmac" in parsed &&
        "prevHmac" in parsed &&
        "index" in parsed
      ) {
        return parsed as AuditEntry;
      }
      return { preLegacy: true, raw: line };
    } catch {
      return { preLegacy: true, raw: line };
    }
  });
}

/**
 * Public read API — returns the full array of `AuditLogLine` entries.
 */
export async function readAuditLog(
  logFile: string = DEFAULT_AUDIT_LOG_FILE,
): Promise<Array<AuditLogLine>> {
  return readAuditLogRaw(logFile);
}

// ── Retention floor (P045) ─────────────────────────────────────────────

/**
 * Check whether an audit entry's timestamp is within the mandatory retention
 * window (resolved via ASSIGNEE_AUDIT_RETENTION_DAYS, minimum 90 days).
 *
 * Returns `true` when the entry must be retained (i.e. CANNOT be deleted),
 * `false` when it is older than the effective floor and may be removed.
 *
 * Used as a guard in any code path that would truncate or delete audit
 * records — call this before any such operation and refuse if it returns true.
 */
export function isAuditEntryWithinRetentionFloor(
  entry: AuditEntry,
  now: Date = new Date(),
): boolean {
  const effectiveDays = resolveAuditRetentionDays();
  const floorMs = effectiveDays * 24 * 60 * 60 * 1000;
  const entryTime = new Date(entry.timestamp).getTime();
  if (Number.isNaN(entryTime)) {
    // Unparseable timestamp — treat as retained (safe default).
    return true;
  }
  return now.getTime() - entryTime < floorMs;
}

/**
 * Attempt to truncate/rotate the audit log at `logFile`, refusing if any
 * retained record (younger than the effective retention floor) would be lost.
 *
 * Returns:
 *   `{ ok: true }` — truncation is safe; no protected records exist.
 *   `{ ok: false, reason: string }` — truncation is BLOCKED because protected
 *     records exist. The caller must NOT delete or truncate the file.
 *
 * The effective floor is MINIMUM_AUDIT_RETENTION_DAYS (90) or higher if
 * ASSIGNEE_AUDIT_RETENTION_DAYS is set to a larger value.
 *
 * **Security invariant (SEC-002)**: this function protects against accidental
 * truncation (e.g. operator `rm` or log-rotation tooling that does not know
 * about the retention floor). It does NOT protect against adversarial
 * truncation by a key-knowing insider who can truncate to a chosen entry and
 * resume signing — the HMAC chain remains internally consistent after such a
 * truncation. Defending against that requires an external anchor (deferred
 * to Epic 101).
 */
export async function guardAuditLogTruncation(
  logFile: string = DEFAULT_AUDIT_LOG_FILE,
  now: Date = new Date(),
): Promise<{ ok: boolean; reason?: string }> {
  const entries = await readAuditLog(logFile);
  const effectiveDays = resolveAuditRetentionDays();
  const retained: AuditEntry[] = [];

  for (const line of entries) {
    if ("preLegacy" in line) continue;
    if (isAuditEntryWithinRetentionFloor(line, now)) {
      retained.push(line);
    }
  }

  if (retained.length === 0) {
    return { ok: true };
  }

  const oldest = retained.reduce((a, b) =>
    new Date(a.timestamp) < new Date(b.timestamp) ? a : b,
  );

  return {
    ok: false,
    reason:
      `Cannot truncate audit log: ${retained.length} record(s) are within the` +
      ` mandatory ${effectiveDays}-day retention floor` +
      ` (minimum: ${MINIMUM_AUDIT_RETENTION_DAYS} days, ISO 27001 A.12.4 + GDPR Art 30 ROPA).` +
      ` Oldest protected record: ${oldest.timestamp} (index ${oldest.index}).` +
      ` Set ASSIGNEE_AUDIT_RETENTION_DAYS to a value ≥ ${MINIMUM_AUDIT_RETENTION_DAYS} to configure the window.`,
  };
}

// ── Sync check (used in tests) ─────────────────────────────────────────

/** Returns true when the audit log file exists. */
export function auditLogExists(
  logFile: string = DEFAULT_AUDIT_LOG_FILE,
): boolean {
  return fsSync.existsSync(logFile);
}
