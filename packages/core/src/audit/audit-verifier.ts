/**
 * W3-01 (Epic 100 Round 5) — Audit-log chain verifier.
 * W9-S2 (2026-04-29) — Auto-fallback to legacy HMAC for pre-W7 entries.
 *
 * Walks all HMAC-bearing entries from `readAuditLog()` and verifies that:
 *   1. Each entry's `hmac` matches `computeChainLink(prevHmac, record, key)`.
 *   2. Each entry's `prevHmac` matches the prior entry's `hmac`
 *      (or `GENESIS_HMAC` for index 0).
 *
 * Auto-fallback (W9-S2): when canonical verification fails for an entry,
 * the verifier re-tries with `legacyVerifyChainLink` (plain JSON.stringify).
 * A legacy pass is accepted ONLY when canonical fails AND legacy succeeds —
 * this distinguishes genuinely old entries from tampered new ones (which
 * would fail both checks). Tampering always returns `hmac-mismatch`.
 *
 * Chain mode: the result carries a `chainMode` field:
 *   - "canonical"  all HMAC-bearing entries verified using canonical JSON.
 *   - "legacy"     all HMAC-bearing entries verified using legacy JSON.stringify.
 *   - "mixed"      some entries used canonical, some used legacy (migration
 *                  in progress).
 *   - "failed"     the chain did not verify successfully.
 *
 * Pre-W3 ("preLegacy") entries are skipped with a "pre-HMAC region" log;
 * verification resumes at the first HMAC-bearing record.
 *
 * If any entry fails verification, the walk stops and returns
 * `{ ok: false, brokenAt: N, reason }`.
 *
 * Remote sink verification (KMS-signed S3 object-lock) defers to Epic 101.
 */

import {
  verifyChainLink,
  legacyVerifyChainLink,
  GENESIS_HMAC,
  getAuditKey,
} from "./hmac-chain.js";
import { readAuditLog, type AuditEntry } from "./audit-log.js";

// ── Types ──────────────────────────────────────────────────────────────

export type VerifyReason =
  | "payload-mismatch"
  | "hmac-mismatch"
  | "missing-prev"
  | "index-gap";

/** Which HMAC serialisation mode was used to verify the chain. */
export type ChainMode = "canonical" | "legacy" | "mixed" | "failed";

export type VerifyResult =
  | { ok: true; total: number; legacyCount: number; chainMode: ChainMode }
  | {
      ok: false;
      brokenAt: number;
      reason: VerifyReason;
      total: number;
      legacyCount: number;
      chainMode: ChainMode;
    };

// ── Verifier ───────────────────────────────────────────────────────────

/**
 * Walk the audit log at `logFile` and verify the HMAC chain.
 *
 * Auto-fallback (W9-S2): for each HMAC-bearing entry, canonical verification
 * is attempted first.  Only if canonical fails AND legacy succeeds is the
 * entry accepted as a pre-W7 record.  An entry that fails BOTH checks is
 * treated as tampered and halts verification with `hmac-mismatch`.
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
  let expectedIndex = 0;

  // Track which serialisation mode was used for each verified entry.
  let canonicalCount = 0;
  let legacyHmacCount = 0;

  for (const entry of entries) {
    // 1. Check index monotonicity FIRST (cheap; avoids unnecessary crypto work).
    if (entry.index !== expectedIndex) {
      return {
        ok: false,
        brokenAt: entry.index,
        reason: "index-gap",
        total,
        legacyCount,
        chainMode: "failed",
      };
    }

    // 2. Check prevHmac linkage.
    if (entry.prevHmac !== expectedPrev) {
      return {
        ok: false,
        brokenAt: entry.index,
        reason: "missing-prev",
        total,
        legacyCount,
        chainMode: "failed",
      };
    }

    // 3. Verify the HMAC over (prevHmac, record).
    //    Try canonical (post-W7) first.  If that fails, try legacy
    //    (pre-W7, plain JSON.stringify) as a fallback.
    //    Only accept the legacy result when canonical fails AND legacy
    //    succeeds — this distinguishes old-format entries from tampered
    //    new ones (both checks would fail for tampering).
    const canonicalValid = verifyChainLink(
      entry.record,
      entry.prevHmac,
      entry.hmac,
      key,
    );

    if (canonicalValid) {
      canonicalCount++;
    } else {
      // Canonical failed — attempt legacy fallback.
      const legacyValid = legacyVerifyChainLink(
        entry.record,
        entry.prevHmac,
        entry.hmac,
        key,
      );

      if (!legacyValid) {
        // Both canonical and legacy failed → tampered entry.
        return {
          ok: false,
          brokenAt: entry.index,
          reason: "hmac-mismatch",
          total,
          legacyCount,
          chainMode: "failed",
        };
      }

      // Legacy-only success: genuinely a pre-W7 entry.
      legacyHmacCount++;
      process.stderr.write(
        `audit-verifier: entry at index ${entry.index} used legacy HMAC; consider migrating with re-sign tooling\n`,
      );
    }

    expectedPrev = entry.hmac;
    expectedIndex++;
  }

  // Determine chainMode from per-entry counters.
  let chainMode: ChainMode;
  if (total === 0 || (canonicalCount === total && legacyHmacCount === 0)) {
    chainMode = "canonical";
  } else if (legacyHmacCount === total && canonicalCount === 0) {
    chainMode = "legacy";
  } else {
    chainMode = "mixed";
  }

  return { ok: true, total, legacyCount, chainMode };
}
