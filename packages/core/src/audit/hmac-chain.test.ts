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
});
