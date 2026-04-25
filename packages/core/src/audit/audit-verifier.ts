/**
 * W3-01 (Epic 100 Round 5) — Audit-log chain verifier.
 *
 * Walks all HMAC-bearing entries from `readAuditLog()` and verifies that:
 *   1. Each entry's `hmac` matches `computeChainLink(prevHmac, record, key)`.
 *   2. Each entry's `prevHmac` matches the prior entry's `hmac`
 *      (or `GENESIS_HMAC` for index 0).
 *
 * Pre-W3 ("legacy") entries are skipped with a "pre-HMAC region" log;
 * verification resumes at the first HMAC-bearing record.
 *
 * If any entry fails verification, the walk stops and returns
 * `{ ok: false, brokenAt: N, reason }`.
 *
 * Remote sink verification (KMS-signed S3 object-lock) defers to Epic 101.
 */

import { verifyChainLink, GENESIS_HMAC, getAuditKey } from "./hmac-chain.js";
import { readAuditLog, type AuditEntry } from "./audit-log.js";

// ── Types ──────────────────────────────────────────────────────────────

export type VerifyReason =
  | "payload-mismatch"
  | "hmac-mismatch"
  | "missing-prev";

export type VerifyResult =
  | { ok: true; total: number; legacyCount: number }
  | {
      ok: false;
      brokenAt: number;
      reason: VerifyReason;
      total: number;
      legacyCount: number;
    };

// ── Verifier ───────────────────────────────────────────────────────────

/**
 * Walk the audit log at `logFile` and verify the HMAC chain.
 *
 * @param logFile - Path to the audit-log NDJSON file.
 * @param key     - HMAC key; defaults to the active audit key.
 */
export async function verifyAuditLog(
  logFile?: string,
  key: string = getAuditKey(),
): Promise<VerifyResult> {
  const lines = await readAuditLog(logFile);

  let legacyCount = 0;
  const entries: AuditEntry[] = [];

  for (const line of lines) {
    if ("preLegacy" in line) {
      legacyCount++;
    } else {
      entries.push(line);
    }
  }

  if (legacyCount > 0) {
    process.stderr.write(
      `[audit-verifier] pre-HMAC region: skipping ${legacyCount} legacy record(s); ` +
        `verification begins at first HMAC-bearing entry\n`,
    );
  }

  const total = entries.length;

  // Verify each entry.
  let expectedPrev = GENESIS_HMAC;

  for (const entry of entries) {
    // Check prevHmac linkage.
    if (entry.prevHmac !== expectedPrev) {
      return {
        ok: false,
        brokenAt: entry.index,
        reason: "missing-prev",
        total,
        legacyCount,
      };
    }

    // Verify the HMAC over (prevHmac, record).
    const valid = verifyChainLink(
      entry.record,
      entry.prevHmac,
      entry.hmac,
      key,
    );
    if (!valid) {
      return {
        ok: false,
        brokenAt: entry.index,
        reason: "hmac-mismatch",
        total,
        legacyCount,
      };
    }

    expectedPrev = entry.hmac;
  }

  return { ok: true, total, legacyCount };
}
