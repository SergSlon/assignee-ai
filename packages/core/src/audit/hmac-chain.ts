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
 *   tooling, compare `legacyHmac(prevHmac, record, key)` (plain
 *   JSON.stringify) against the stored HMAC, then re-sign with
 *   `computeChainLink` once verified.  New chains written after upgrading
 *   use canonical JSON and are forward-compatible across all environments.
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
