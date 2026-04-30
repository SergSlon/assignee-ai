/**
 * W3-01 — HMAC chain primitive tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  computeChainLink,
  verifyChainLink,
  getAuditKey,
  GENESIS_HMAC,
} from "./hmac-chain.js";

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

  it("returns the env var when set", () => {
    process.env["ASSIGNEE_AUDIT_KEY"] = "test-key-from-env";
    expect(getAuditKey()).toBe("test-key-from-env");
  });

  it("returns a non-empty string when env var is absent", () => {
    delete process.env["ASSIGNEE_AUDIT_KEY"];
    const key = getAuditKey();
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
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
