/**
 * W3-01 (Epic 100 Round 5) — Audit-log chain verifier.
 * W9-S2 (2026-04-29) — Auto-fallback to legacy HMAC for pre-W7 entries.
 * SEC-A-4 (2026-04-29) — Gate legacy fallback behind opt-in env var; scoped
 *   tamper-evident claim; rollback threat acknowledged.
 *
 * Walks all HMAC-bearing entries from `readAuditLog()` and verifies that:
 *   1. Each entry's `hmac` matches `computeChainLink(prevHmac, record, key)`.
 *   2. Each entry's `prevHmac` matches the prior entry's `hmac`
 *      (or `GENESIS_HMAC` for index 0).
 *
 * **Tamper-evidence scope (SEC-002)**: the audit chain is tamper-evident
 * against attackers who do NOT have read access to the audit key file
 * (~/.assignee/audit-key, 0o600). A same-uid insider with both write access
 * to the log file and read access to the key file can truncate to a chosen
 * entry and resume signing. The chain-link structure makes this detectable
 * only when an external anchor exists. An external anchor (S3 Object Lock,
 * remote append-only sink, signed digest) is deferred to Epic 101.
 * @see docs/explanation/audit-threat-model.md for the full threat model.
 *
 * Legacy fallback (W9-S2, SEC-035): when canonical verification fails for
 * an entry, the verifier re-tries with `legacyVerifyChainLink` (plain
 * JSON.stringify) ONLY if `ASSIGNEE_AUDIT_ALLOW_LEGACY=1` is set.
 * When the flag is absent, any entry whose canonical HMAC fails causes the
 * verifier to return `{ ok: false, reason: "legacy-hmac-not-allowed" }`.
 * The `legacyVerifyChainLink` function also guards the same env var and
 * throws `LEGACY_HMAC_NOT_ALLOWED` without it — this is defense in depth.
 * // Legacy fallback: remove after 2027-04-29 once all chains have been re-signed.
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
  LEGACY_HMAC_OPT_IN_ENV,
  getAuditKey,
} from "./hmac-chain.js";
import { readAuditLog, type AuditEntry } from "./audit-log.js";

// ── Types ──────────────────────────────────────────────────────────────

export type VerifyReason =
  | "payload-mismatch"
  | "hmac-mismatch"
  | "missing-prev"
  | "index-gap"
  | "legacy-hmac-not-allowed";

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
 * Auto-fallback (W9-S2, SEC-035): for each HMAC-bearing entry, canonical
 * verification is attempted first.  Only if canonical fails AND legacy
 * succeeds is the entry considered a pre-W7 record — BUT only when
 * `ASSIGNEE_AUDIT_ALLOW_LEGACY=1` (`LEGACY_HMAC_OPT_IN_ENV`) is set.
 * Without that flag, a legacy-only HMAC match is rejected with
 * `{ ok: false, reason: "legacy-hmac-not-allowed" }` to prevent insider
 * downgrade attacks (SEC-035).  An entry that fails BOTH checks is treated
 * as tampered and halts verification with `hmac-mismatch`.
 *
 * **Note on rollback (SEC-002)**: this verifier detects accidental truncation
 * and external tampering, but a key-knowing insider can truncate to a chosen
 * entry and resume signing.  An external anchor is deferred to Epic 101.
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
    //    (pre-W7, plain JSON.stringify) as a fallback — but ONLY when
    //    ASSIGNEE_AUDIT_ALLOW_LEGACY=1 (LEGACY_HMAC_OPT_IN_ENV) is set (SEC-035).
    //    Accepting legacy without an opt-in allows an insider to degrade
    //    the chain by re-signing tampered records under legacy HMAC.
    //    Only accept the legacy result when canonical fails AND legacy
    //    succeeds AND the opt-in flag is set — this distinguishes old-format
    //    entries from tampered new ones (both checks would fail for tampering).
    // Legacy fallback: remove after 2027-04-29 once all chains have been re-signed.
    const canonicalValid = verifyChainLink(
      entry.record,
      entry.prevHmac,
      entry.hmac,
      key,
    );

    if (canonicalValid) {
      canonicalCount++;
    } else {
      // Canonical failed — attempt legacy fallback only when opted in.
      // Use the same LEGACY_HMAC_OPT_IN_ENV that legacyVerifyChainLink reads
      // so there is one source-of-truth for the opt-in gate (SEC-035).
      const legacyAllowed =
        process.env[LEGACY_HMAC_OPT_IN_ENV] !== undefined &&
        process.env[LEGACY_HMAC_OPT_IN_ENV] !== "0" &&
        process.env[LEGACY_HMAC_OPT_IN_ENV]?.toLowerCase() !== "false";

      if (!legacyAllowed) {
        // Legacy fallback is disabled; reject without trying.
        return {
          ok: false,
          brokenAt: entry.index,
          reason: "legacy-hmac-not-allowed",
          total,
          legacyCount,
          chainMode: "failed",
        };
      }

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

      // Legacy-only success: genuinely a pre-W7 entry (opt-in allowed).
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
