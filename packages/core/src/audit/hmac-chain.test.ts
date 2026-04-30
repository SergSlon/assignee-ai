/**
 * W3-01 — HMAC chain primitive tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  computeChainLink,
  verifyChainLink,
  legacyComputeChainLink,
  legacyVerifyChainLink,
  getAuditKey,
  GENESIS_HMAC,
  AUDIT_KEY_MIN_LENGTH,
} from "./hmac-chain.js";
import { AssigneeError } from "../errors.js";

// ── Key derivation tests ────────────────────────────────────────────────

describe("getAuditKey", () => {
  const ORIGINAL_ENV = process.env["ASSIGNEE_AUDIT_KEY"];

  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env["ASSIGNEE_AUDIT_KEY"] = ORIGINAL_ENV;
    } else {
      delete process.env["ASSIGNEE_AUDIT_KEY"];
    }
  });

  it("returns the env var when set to a key of sufficient length (≥32 chars)", () => {
    // Use exactly 32 characters — the boundary value that must pass.
    const key32 = "a".repeat(32);
    process.env["ASSIGNEE_AUDIT_KEY"] = key32;
    expect(getAuditKey()).toBe(key32);
  });

  it("returns a non-empty string when env var is absent (per-process fallback)", () => {
    delete process.env["ASSIGNEE_AUDIT_KEY"];
    const key = getAuditKey();
    expect(typeof key).toBe("string");
    // Per-process fallback is randomBytes(32).toString("hex") → 64 chars, always ≥ 32.
    expect(key.length).toBeGreaterThanOrEqual(AUDIT_KEY_MIN_LENGTH);
  });

  // ── W9-S3: minimum key-length enforcement ─────────────────────────────

  it("throws AUDIT_KEY_TOO_SHORT when ASSIGNEE_AUDIT_KEY is shorter than 32 chars (31 chars)", () => {
    process.env["ASSIGNEE_AUDIT_KEY"] = "a".repeat(31);
    expect(() => getAuditKey()).toThrow(AssigneeError);
    try {
      getAuditKey();
    } catch (err) {
      expect(err).toBeInstanceOf(AssigneeError);
      expect((err as AssigneeError).code).toBe("AUDIT_KEY_TOO_SHORT");
    }
  });

  it("throws AUDIT_KEY_TOO_SHORT for a single-character key (extreme short case)", () => {
    process.env["ASSIGNEE_AUDIT_KEY"] = "x";
    expect(() => getAuditKey()).toThrow(AssigneeError);
    try {
      getAuditKey();
    } catch (err) {
      expect((err as AssigneeError).code).toBe("AUDIT_KEY_TOO_SHORT");
    }
  });

  it("passes with a key of exactly 32 characters (boundary pass)", () => {
    const key32 = "b".repeat(32);
    process.env["ASSIGNEE_AUDIT_KEY"] = key32;
    expect(getAuditKey()).toBe(key32);
  });

  it("error message contains the openssl rand -hex 32 hint", () => {
    process.env["ASSIGNEE_AUDIT_KEY"] = "short";
    let caught: unknown;
    try {
      getAuditKey();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssigneeError);
    expect((caught as AssigneeError).message).toContain("openssl rand -hex 32");
  });

  it("per-process fallback (no env var) never triggers AUDIT_KEY_TOO_SHORT (random key always ≥ 32)", () => {
    delete process.env["ASSIGNEE_AUDIT_KEY"];
    // Should not throw — randomBytes(32).toString("hex") produces 64 chars.
    expect(() => getAuditKey()).not.toThrow();
  });
});

// ── computeChainLink tests ──────────────────────────────────────────────

describe("computeChainLink", () => {
  const KEY = "test-fixed-key-for-unit-tests";

  it("returns a non-empty hex string", () => {
    const hmac = computeChainLink(GENESIS_HMAC, { action: "plan" }, KEY);
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const record = { action: "apply", resource: "AWS::S3::Bucket" };
    const h1 = computeChainLink(GENESIS_HMAC, record, KEY);
    const h2 = computeChainLink(GENESIS_HMAC, record, KEY);
    expect(h1).toBe(h2);
  });

  it("changes when prevHmac changes", () => {
    const record = { action: "plan" };
    const h1 = computeChainLink(GENESIS_HMAC, record, KEY);
    const h2 = computeChainLink("some-other-prev", record, KEY);
    expect(h1).not.toBe(h2);
  });

  it("changes when record changes", () => {
    const h1 = computeChainLink(GENESIS_HMAC, { action: "plan" }, KEY);
    const h2 = computeChainLink(GENESIS_HMAC, { action: "apply" }, KEY);
    expect(h1).not.toBe(h2);
  });

  it("changes when key changes", () => {
    const record = { action: "plan" };
    const h1 = computeChainLink(GENESIS_HMAC, record, "key-a");
    const h2 = computeChainLink(GENESIS_HMAC, record, "key-b");
    expect(h1).not.toBe(h2);
  });

  it("accepts complex nested record objects", () => {
    const record = {
      action: "apply",
      resource: "AWS::EC2::Instance",
      tags: { Env: "prod", App: "api" },
      count: 3,
    };
    const hmac = computeChainLink(GENESIS_HMAC, record, KEY);
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Canonical-JSON (W7-S2) invariants ────────────────────────────────────

  it("produces the same HMAC regardless of object key insertion order (canonical-JSON)", () => {
    // These two objects are logically identical but built with different
    // key-insertion orders — vanilla JSON.stringify would produce different
    // strings on some runtimes; canonicalJson must produce the same one.
    const recordAB = { action: "apply", resource: "AWS::S3::Bucket" };
    const recordBA = Object.assign(
      Object.create(null) as Record<string, string>,
      { resource: "AWS::S3::Bucket", action: "apply" },
    );
    const hmacAB = computeChainLink(GENESIS_HMAC, recordAB, KEY);
    const hmacBA = computeChainLink(GENESIS_HMAC, recordBA, KEY);
    expect(hmacAB).toBe(hmacBA);
  });

  it("sorts nested object keys canonically", () => {
    const recordZA = {
      z: "last",
      tags: { zebra: 1, alpha: 2 },
      a: "first",
    };
    const recordAZ = {
      a: "first",
      tags: { alpha: 2, zebra: 1 },
      z: "last",
    };
    expect(computeChainLink(GENESIS_HMAC, recordZA, KEY)).toBe(
      computeChainLink(GENESIS_HMAC, recordAZ, KEY),
    );
  });

  it("preserves array element order (only object keys are sorted)", () => {
    const r1 = { items: [3, 1, 2] };
    const r2 = { items: [1, 2, 3] };
    // Array order must NOT be canonicalised — different arrays → different HMACs.
    expect(computeChainLink(GENESIS_HMAC, r1, KEY)).not.toBe(
      computeChainLink(GENESIS_HMAC, r2, KEY),
    );
  });

  it("handles null, numbers, booleans, and strings as record roots", () => {
    // Scalar/null roots should not throw and should be deterministic.
    expect(computeChainLink(GENESIS_HMAC, null, KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeChainLink(GENESIS_HMAC, 42, KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeChainLink(GENESIS_HMAC, true, KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeChainLink(GENESIS_HMAC, "hello", KEY)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

// ── verifyChainLink tests ───────────────────────────────────────────────

describe("verifyChainLink", () => {
  const KEY = "test-fixed-key-for-unit-tests";

  it("returns true for a correctly computed link", () => {
    const record = { action: "plan", resource: "AWS::S3::Bucket" };
    const hmac = computeChainLink(GENESIS_HMAC, record, KEY);
    expect(verifyChainLink(record, GENESIS_HMAC, hmac, KEY)).toBe(true);
  });

  it("returns false when the stored HMAC is wrong (hmac-mismatch)", () => {
    const record = { action: "plan" };
    const correctHmac = computeChainLink(GENESIS_HMAC, record, KEY);
    const corruptedHmac = correctHmac.slice(0, -1) + "x";
    expect(verifyChainLink(record, GENESIS_HMAC, corruptedHmac, KEY)).toBe(
      false,
    );
  });

  it("returns false when the record payload is altered (payload-mismatch)", () => {
    const record = { action: "plan", resource: "AWS::S3::Bucket" };
    const hmac = computeChainLink(GENESIS_HMAC, record, KEY);
    const alteredRecord = { action: "destroy", resource: "AWS::S3::Bucket" };
    expect(verifyChainLink(alteredRecord, GENESIS_HMAC, hmac, KEY)).toBe(false);
  });

  it("returns false when prevHmac is altered", () => {
    const record = { action: "plan" };
    const hmac = computeChainLink(GENESIS_HMAC, record, KEY);
    expect(verifyChainLink(record, "wrong-prev", hmac, KEY)).toBe(false);
  });

  it("returns false when key differs", () => {
    const record = { action: "plan" };
    const hmac = computeChainLink(GENESIS_HMAC, record, "key-a");
    expect(verifyChainLink(record, GENESIS_HMAC, hmac, "key-b")).toBe(false);
  });

  it("verifies a chain of multiple links", () => {
    const key = KEY;
    const r0 = { action: "plan", index: 0 };
    const r1 = { action: "apply", index: 1 };
    const r2 = { action: "destroy", index: 2 };

    const h0 = computeChainLink(GENESIS_HMAC, r0, key);
    const h1 = computeChainLink(h0, r1, key);
    const h2 = computeChainLink(h1, r2, key);

    expect(verifyChainLink(r0, GENESIS_HMAC, h0, key)).toBe(true);
    expect(verifyChainLink(r1, h0, h1, key)).toBe(true);
    expect(verifyChainLink(r2, h1, h2, key)).toBe(true);
  });

  // ── timingSafeEqual invariants ─────────────────────────────────────────

  it("returns false for a storedHmac shorter than the expected HMAC (length-mismatch short)", () => {
    const record = { action: "plan" };
    const correctHmac = computeChainLink(GENESIS_HMAC, record, KEY);
    // A shorter stored HMAC must not throw — just return false.
    expect(
      verifyChainLink(record, GENESIS_HMAC, correctHmac.slice(0, 32), KEY),
    ).toBe(false);
  });

  it("returns false for a storedHmac longer than the expected HMAC (length-mismatch long)", () => {
    const record = { action: "plan" };
    const correctHmac = computeChainLink(GENESIS_HMAC, record, KEY);
    // A longer stored HMAC must not throw — just return false.
    expect(verifyChainLink(record, GENESIS_HMAC, correctHmac + "00", KEY)).toBe(
      false,
    );
  });

  it("returns false for an empty storedHmac (length-mismatch empty)", () => {
    const record = { action: "plan" };
    expect(verifyChainLink(record, GENESIS_HMAC, "", KEY)).toBe(false);
  });

  it("returns false for an all-zero storedHmac of the correct length (same-length wrong value)", () => {
    const record = { action: "plan" };
    const correctHmac = computeChainLink(GENESIS_HMAC, record, KEY);
    // Replace every char with '0' — same byte-length, completely wrong value.
    const zeroedHmac = "0".repeat(correctHmac.length);
    expect(verifyChainLink(record, GENESIS_HMAC, zeroedHmac, KEY)).toBe(false);
  });

  it("uses timingSafeEqual: does not throw when buffers are the same length but differ by one bit", () => {
    const record = { action: "apply", resource: "AWS::IAM::Role" };
    const correctHmac = computeChainLink(GENESIS_HMAC, record, KEY);
    // Flip the last hex character to produce a same-length but incorrect HMAC.
    const lastChar = correctHmac[correctHmac.length - 1];
    const flippedChar = lastChar === "f" ? "e" : "f";
    const flippedHmac = correctHmac.slice(0, -1) + flippedChar;
    expect(() =>
      verifyChainLink(record, GENESIS_HMAC, flippedHmac, KEY),
    ).not.toThrow();
    expect(verifyChainLink(record, GENESIS_HMAC, flippedHmac, KEY)).toBe(false);
  });
});

// ── legacyComputeChainLink tests (W8-S0) ───────────────────────────────────

describe("legacyComputeChainLink", () => {
  const KEY = "test-fixed-key-for-unit-tests";

  it("returns a 64-char hex string", () => {
    const hmac = legacyComputeChainLink(GENESIS_HMAC, { action: "plan" }, KEY);
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const record = { action: "apply", resource: "AWS::S3::Bucket" };
    const h1 = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    const h2 = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    expect(h1).toBe(h2);
  });

  it("produces a DIFFERENT HMAC than computeChainLink for multi-key records (key-order sensitivity confirmed)", () => {
    // { b: 1, a: 2 } — canonical sorts to {"a":2,"b":1}; legacy keeps
    // insertion order {"b":1,"a":2}.  They produce distinct payloads →
    // distinct HMACs.
    const record = { b: 1, a: 2 };
    const canonical = computeChainLink(GENESIS_HMAC, record, KEY);
    const legacy = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    expect(legacy).not.toBe(canonical);
  });

  it("agrees with computeChainLink for single-key records (degenerate case)", () => {
    // A single-key object serialises identically under both strategies.
    const record = { action: "plan" };
    const canonical = computeChainLink(GENESIS_HMAC, record, KEY);
    const legacy = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    expect(legacy).toBe(canonical);
  });

  it("changes when prevHmac changes", () => {
    const record = { b: 2, a: 1 };
    const h1 = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    const h2 = legacyComputeChainLink("some-other-prev", record, KEY);
    expect(h1).not.toBe(h2);
  });

  it("changes when key changes", () => {
    const record = { b: 2, a: 1 };
    const h1 = legacyComputeChainLink(GENESIS_HMAC, record, "key-a");
    const h2 = legacyComputeChainLink(GENESIS_HMAC, record, "key-b");
    expect(h1).not.toBe(h2);
  });
});

// ── legacyVerifyChainLink tests (W8-S0) ────────────────────────────────────

describe("legacyVerifyChainLink", () => {
  const KEY = "test-fixed-key-for-unit-tests";

  it("returns true for a correctly computed legacy link", () => {
    const record = { b: 1, a: 2 };
    const hmac = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    expect(legacyVerifyChainLink(record, GENESIS_HMAC, hmac, KEY)).toBe(true);
  });

  it("returns false for a link computed with the canonical helper (migration boundary confirmed)", () => {
    // A multi-key record built with computeChainLink (canonical) must fail
    // legacyVerifyChainLink because the serialised payloads differ.
    const record = { b: 1, a: 2 };
    const canonicalHmac = computeChainLink(GENESIS_HMAC, record, KEY);
    expect(
      legacyVerifyChainLink(record, GENESIS_HMAC, canonicalHmac, KEY),
    ).toBe(false);
  });

  it("returns true when canonical and legacy HMACs agree (single-key degenerate case)", () => {
    // Single-key records produce identical serialisations under both
    // strategies, so either verifier must accept the other's output.
    const record = { action: "plan" };
    const canonicalHmac = computeChainLink(GENESIS_HMAC, record, KEY);
    expect(
      legacyVerifyChainLink(record, GENESIS_HMAC, canonicalHmac, KEY),
    ).toBe(true);
  });

  it("returns false for a corrupted HMAC", () => {
    const record = { b: 1, a: 2 };
    const hmac = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    const corrupted = hmac.slice(0, -1) + (hmac.endsWith("f") ? "e" : "f");
    expect(legacyVerifyChainLink(record, GENESIS_HMAC, corrupted, KEY)).toBe(
      false,
    );
  });

  it("returns false when prevHmac is wrong", () => {
    const record = { b: 1, a: 2 };
    const hmac = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    expect(legacyVerifyChainLink(record, "wrong-prev", hmac, KEY)).toBe(false);
  });

  it("returns false when key differs", () => {
    const record = { b: 1, a: 2 };
    const hmac = legacyComputeChainLink(GENESIS_HMAC, record, "key-a");
    expect(legacyVerifyChainLink(record, GENESIS_HMAC, hmac, "key-b")).toBe(
      false,
    );
  });

  it("returns false for a length-mismatched storedHmac (short)", () => {
    const record = { b: 1, a: 2 };
    const hmac = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    expect(
      legacyVerifyChainLink(record, GENESIS_HMAC, hmac.slice(0, 32), KEY),
    ).toBe(false);
  });

  it("returns false for an empty storedHmac", () => {
    const record = { b: 1, a: 2 };
    expect(legacyVerifyChainLink(record, GENESIS_HMAC, "", KEY)).toBe(false);
  });

  it("uses timingSafeEqual: does not throw for same-length wrong HMAC", () => {
    const record = { b: 1, a: 2 };
    const correctHmac = legacyComputeChainLink(GENESIS_HMAC, record, KEY);
    const zeroedHmac = "0".repeat(correctHmac.length);
    expect(() =>
      legacyVerifyChainLink(record, GENESIS_HMAC, zeroedHmac, KEY),
    ).not.toThrow();
    expect(legacyVerifyChainLink(record, GENESIS_HMAC, zeroedHmac, KEY)).toBe(
      false,
    );
  });

  it("verifies a multi-link legacy chain end-to-end (re-sign flow works)", () => {
    // Simulates: pre-W7 chain built with legacyComputeChainLink, then each
    // entry is verified with legacyVerifyChainLink and re-signed with
    // computeChainLink.  After re-signing, verifyChainLink must pass.
    const r0 = { z: "last", a: "first" };
    const r1 = { b: 2, a: 1 };

    // Step 1: build a legacy chain (pre-W7 style)
    const legacyH0 = legacyComputeChainLink(GENESIS_HMAC, r0, KEY);
    const legacyH1 = legacyComputeChainLink(legacyH0, r1, KEY);

    // Step 2: verify legacy chain passes legacyVerifyChainLink
    expect(legacyVerifyChainLink(r0, GENESIS_HMAC, legacyH0, KEY)).toBe(true);
    expect(legacyVerifyChainLink(r1, legacyH0, legacyH1, KEY)).toBe(true);

    // Step 3: re-sign to canonical
    const canonicalH0 = computeChainLink(GENESIS_HMAC, r0, KEY);
    const canonicalH1 = computeChainLink(canonicalH0, r1, KEY);

    // Step 4: re-signed chain passes canonical verifier
    expect(verifyChainLink(r0, GENESIS_HMAC, canonicalH0, KEY)).toBe(true);
    expect(verifyChainLink(r1, canonicalH0, canonicalH1, KEY)).toBe(true);

    // Step 5: original legacy HMACs fail the canonical verifier (multi-key records)
    expect(verifyChainLink(r0, GENESIS_HMAC, legacyH0, KEY)).toBe(false);
  });
});
