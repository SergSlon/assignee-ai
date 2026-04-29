/**
 * W3-01 (Epic 100 Round 5) — HMAC chain primitive.
 *
 * Each audit-log record is linked to the previous by an HMAC that covers
 * both the prior link's HMAC and the current record's serialised payload.
 * This makes the chain tamper-evident: altering any record or its HMAC
 * breaks every subsequent link.
 *
 * Algorithm: HMAC-SHA256 over `prevHmac + "|" + JSON.stringify(record)`.
 * The pipe separator prevents length-extension ambiguity when prevHmac is
 * the sentinel value "GENESIS" for the first record.
 *
 * Key management:
 *   - Production: `ASSIGNEE_AUDIT_KEY` env var (per-tenant secret).
 *   - Dev/CI: auto-generated per-process key with a console warning.
 *     KMS-backed key management defers to Epic 101.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";

// ── Key management ─────────────────────────────────────────────────────

/** Sentinel HMAC value written as the `prevHmac` of the first record. */
export const GENESIS_HMAC = "GENESIS";

let _perProcessKey: string | undefined;

/**
 * Return the active audit key.
 *
 * Priority:
 *   1. `ASSIGNEE_AUDIT_KEY` env var (per-tenant, persists across restarts).
 *   2. Per-process random key (emits a WARNING once; chain not durable
 *      across process restarts — configure the env var in production).
 *
 * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
 * supply a tenant-scoped key source instead of the process-global
 * `process.env`. When omitted, falls back to a fresh
 * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
 */
export function getAuditKey(config?: ConfigPort): string {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  const envKey = effectiveConfig.get("ASSIGNEE_AUDIT_KEY");
  if (envKey && envKey.length > 0) return envKey;

  if (!_perProcessKey) {
    _perProcessKey = randomBytes(32).toString("hex");
    // Use process.stderr.write to avoid any log-level suppression.
    process.stderr.write(
      "WARNING: per-process audit key in use — chain is not durable across" +
        " restarts; configure ASSIGNEE_AUDIT_KEY in production\n",
    );
  }
  return _perProcessKey;
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
  const payload = `${prevHmac}|${JSON.stringify(record)}`;
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
