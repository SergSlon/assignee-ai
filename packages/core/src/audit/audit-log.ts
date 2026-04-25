/**
 * W3-01 + W3-02 (Epic 100 Round 5) — Tamper-evident audit log.
 *
 * Write path: each appended record is wrapped with `{record, hmac, prevHmac, index}`
 * and serialised as NDJSON (one JSON line per entry). Writes go through the
 * W4-03 advisory-lock service to prevent concurrent-writer corruption.
 *
 * Read path: `readAuditLog()` returns the entries as an array with full chain
 * metadata so the verifier can walk the chain.
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
import { randomBytes } from "node:crypto";
import { computeChainLink, GENESIS_HMAC } from "./hmac-chain.js";
import { getCurrentRole } from "../rbac/role-context.js";
import { defaultFileAdvisoryLock } from "../locks/file-advisory-lock.js";

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

    // Atomic append: write to a temp file then rename-append via a
    // single O_WRONLY|O_APPEND open to avoid partial-line races.
    // For NDJSON append the simplest safe form is fs.appendFile with
    // an exclusive advisory lock already held above.
    const tmpSuffix = randomBytes(4).toString("hex");
    const tmpPath = `${logFile}.tmp.${tmpSuffix}`;
    await fs.writeFile(tmpPath, line, { mode: 0o600 });

    // Append the temp content then remove.
    const buf = await fs.readFile(tmpPath);
    await fs.appendFile(logFile, buf);
    await fs.chmod(logFile, 0o600).catch(() => {});
    await fs.unlink(tmpPath).catch(() => {});

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

// ── Sync check (used in tests) ─────────────────────────────────────────

/** Returns true when the audit log file exists. */
export function auditLogExists(
  logFile: string = DEFAULT_AUDIT_LOG_FILE,
): boolean {
  return fsSync.existsSync(logFile);
}
