/**
 * Unit tests for checkpoint-hmac.ts — in-process HMAC integrity store.
 *
 * W18-S2 (DEF-07 M-β-012/013): covers all three `CheckpointVerifyResult`
 * branches so callers can rely on the discriminated-union reason codes.
 *
 * @see Story 50-5 B-2, Story W18-S2
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  canonicalizeCheckpointPath,
  computeDesiredStateHash,
  signCheckpoint,
  verifyCheckpoint,
  verifyHmac,
  _resetSignaturesForTests,
} from "./checkpoint-hmac.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_PATH = "/tmp/assignee-hmac-test/checkpoint.json";
const CANONICAL = canonicalizeCheckpointPath(TEST_PATH);
const DESIRED_STATE: Record<string, unknown> = {
  BucketName: "test-bucket",
  Region: "us-east-1",
};
const HASH = computeDesiredStateHash(DESIRED_STATE);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sign the canonical path and return it for use in verify calls. */
function signAndReturnHash(
  canonicalPath: string = CANONICAL,
  desiredState: Record<string, unknown> = DESIRED_STATE,
): string {
  const h = computeDesiredStateHash(desiredState);
  signCheckpoint(canonicalPath, h);
  return h;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkpoint-hmac", () => {
  beforeEach(() => {
    _resetSignaturesForTests();
  });

  // ── canonicalizeCheckpointPath ────────────────────────────────────────────

  describe("canonicalizeCheckpointPath", () => {
    it("resolves relative paths to absolute", () => {
      const result = canonicalizeCheckpointPath("./tmp/checkpoint.json");
      expect(result.startsWith("/")).toBe(true);
    });

    it("normalises '..' segments", () => {
      const a = canonicalizeCheckpointPath("/tmp/../tmp/checkpoint.json");
      const b = canonicalizeCheckpointPath("/tmp/checkpoint.json");
      expect(a).toBe(b);
    });

    it("returns the same string for an already-canonical path", () => {
      expect(canonicalizeCheckpointPath(CANONICAL)).toBe(CANONICAL);
    });
  });

  // ── computeDesiredStateHash ───────────────────────────────────────────────

  describe("computeDesiredStateHash", () => {
    it("returns a 64-char hex string (SHA-256)", () => {
      expect(HASH).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same object regardless of key insertion order", () => {
      const h1 = computeDesiredStateHash({ a: 1, b: 2 });
      const h2 = computeDesiredStateHash({ b: 2, a: 1 });
      expect(h1).toBe(h2);
    });

    it("differs for semantically different objects", () => {
      const h1 = computeDesiredStateHash({ BucketName: "a" });
      const h2 = computeDesiredStateHash({ BucketName: "b" });
      expect(h1).not.toBe(h2);
    });
  });

  // ── verifyCheckpoint — happy path ─────────────────────────────────────────

  describe("verifyCheckpoint — ok: true", () => {
    it("returns { ok: true } for a path that was correctly signed", () => {
      const h = signAndReturnHash();
      const result = verifyCheckpoint(CANONICAL, h);
      expect(result).toEqual({ ok: true });
    });

    it("returns { ok: true } for a second distinct path signed independently", () => {
      const path2 = canonicalizeCheckpointPath("/tmp/other.json");
      const h2 = computeDesiredStateHash({ Key: "other" });
      signCheckpoint(path2, h2);

      const result = verifyCheckpoint(path2, h2);
      expect(result).toEqual({ ok: true });
    });
  });

  // ── verifyCheckpoint — reason: "not-registered" ───────────────────────────

  describe('verifyCheckpoint — reason: "not-registered"', () => {
    it("returns not-registered when the path was never signed", () => {
      const result = verifyCheckpoint(CANONICAL, HASH);
      expect(result).toEqual({ ok: false, reason: "not-registered" });
    });

    it("returns not-registered after _resetSignaturesForTests wipes the map", () => {
      signAndReturnHash();
      _resetSignaturesForTests();
      const result = verifyCheckpoint(CANONICAL, HASH);
      expect(result).toEqual({ ok: false, reason: "not-registered" });
    });

    it("returns not-registered for a path that differs only in case / normalization", () => {
      // Sign one path; verify with a logically different canonical path
      signCheckpoint(CANONICAL, HASH);
      const differentPath = canonicalizeCheckpointPath(
        "/tmp/assignee-hmac-test/OTHER.json",
      );
      const result = verifyCheckpoint(differentPath, HASH);
      expect(result).toEqual({ ok: false, reason: "not-registered" });
    });
  });

  // ── verifyCheckpoint — reason: "tampered" ────────────────────────────────

  describe('verifyCheckpoint — reason: "tampered"', () => {
    it("returns tampered when the desiredState hash has changed since signing", () => {
      signAndReturnHash(); // registers HASH for DESIRED_STATE
      const alteredHash = computeDesiredStateHash({
        BucketName: "tampered-bucket",
      });
      const result = verifyCheckpoint(CANONICAL, alteredHash);
      expect(result).toEqual({ ok: false, reason: "tampered" });
    });

    it("returns tampered for any single-byte deviation in desiredState", () => {
      signAndReturnHash();
      const tweakedHash = computeDesiredStateHash({
        ...DESIRED_STATE,
        ExtraField: "injected",
      });
      const result = verifyCheckpoint(CANONICAL, tweakedHash);
      expect(result).toEqual({ ok: false, reason: "tampered" });
    });

    it("does NOT return not-registered when the path IS registered but hash differs", () => {
      signAndReturnHash();
      const wrongHash = "0".repeat(64);
      const result = verifyCheckpoint(CANONICAL, wrongHash);
      // must be tampered, not not-registered
      expect(result.ok).toBe(false);
      // narrow the discriminated union
      if (!result.ok) {
        expect(result.reason).toBe("tampered");
      }
    });
  });

  // ── verifyHmac alias ──────────────────────────────────────────────────────

  describe("verifyHmac alias", () => {
    it("is the same function reference as verifyCheckpoint", () => {
      expect(verifyHmac).toBe(verifyCheckpoint);
    });

    it("returns { ok: true } via the alias for a correctly signed path", () => {
      const h = signAndReturnHash();
      expect(verifyHmac(CANONICAL, h)).toEqual({ ok: true });
    });

    it("returns not-registered via the alias for an unsigned path", () => {
      expect(verifyHmac(CANONICAL, HASH)).toEqual({
        ok: false,
        reason: "not-registered",
      });
    });
  });

  // ── sign + verify isolation between paths ─────────────────────────────────

  describe("sign/verify isolation", () => {
    it("signing path A does not validate path B", () => {
      const pathA = canonicalizeCheckpointPath("/tmp/a.json");
      const pathB = canonicalizeCheckpointPath("/tmp/b.json");
      const h = computeDesiredStateHash({ x: 1 });
      signCheckpoint(pathA, h);

      expect(verifyCheckpoint(pathA, h)).toEqual({ ok: true });
      expect(verifyCheckpoint(pathB, h)).toEqual({
        ok: false,
        reason: "not-registered",
      });
    });

    it("re-signing with a new hash invalidates the old hash", () => {
      const oldHash = computeDesiredStateHash({ v: 1 });
      signCheckpoint(CANONICAL, oldHash);

      const newHash = computeDesiredStateHash({ v: 2 });
      signCheckpoint(CANONICAL, newHash);

      expect(verifyCheckpoint(CANONICAL, newHash)).toEqual({ ok: true });
      expect(verifyCheckpoint(CANONICAL, oldHash)).toEqual({
        ok: false,
        reason: "tampered",
      });
    });
  });
});
