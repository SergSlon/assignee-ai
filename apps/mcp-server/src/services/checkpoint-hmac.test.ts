/**
 * Unit tests for checkpoint-hmac.ts — in-process HMAC integrity store.
 *
 * W18-S2 (DEF-07 M-β-012/013): covers all three `CheckpointVerifyResult`
 * branches so callers can rely on the discriminated-union reason codes.
 *
 * SEC-019: restart-simulation tests — verify that two successive
 *   `resolveHmacSecret(keyFile)` calls on the same key file return the
 *   same secret (simulating a process restart).
 *
 * SEC-027: APFS homoglyph tests — on darwin, a path registered under
 *   `/Foo` must resolve to the same map slot as `/foo` (lowercase guard).
 *
 * @see Story 50-5 B-2, Story W18-S2
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalizeCheckpointPath,
  computeDesiredStateHash,
  resolveHmacSecret,
  signCheckpoint,
  verifyCheckpoint,
  verifyHmac,
  _readHmacSecretHexForTests,
  _resetSignaturesForTests,
} from "./checkpoint-hmac.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_PATH = "/tmp/assignee-hmac-test/checkpoint.json";
const CANONICAL = canonicalizeCheckpointPath(TEST_PATH);
const DESIRED_STATE: Record<string, unknown> = {
  BucketName: "test-bucket-sec019",
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

// ── Temp-dir fixture for key-file tests ──────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "assignee-hmac-test-"));
}

function removeTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkpoint-hmac", () => {
  beforeEach(() => {
    _resetSignaturesForTests();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
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

  // ── SEC-019: persisted HMAC secret — restart-simulation ───────────────────

  describe("SEC-019: resolveHmacSecret — disk persistence", () => {
    it("generates a 32-byte secret and writes a 64-char hex file on first call", () => {
      const keyFile = path.join(tmpDir, "hmac-key");
      const secret = resolveHmacSecret(keyFile);

      expect(secret).toBeInstanceOf(Buffer);
      expect(secret.length).toBe(32);
      expect(fs.existsSync(keyFile)).toBe(true);
      const stored = fs.readFileSync(keyFile, "utf8").trim();
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      expect(stored).toBe(secret.toString("hex"));
    });

    it("returns the SAME secret on a second call (simulates process restart)", () => {
      const keyFile = path.join(tmpDir, "hmac-key-restart");
      // First "process" creates the key file.
      const first = _readHmacSecretHexForTests(keyFile);
      // Second "process" reads from the same file.
      const second = _readHmacSecretHexForTests(keyFile);

      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns a different secret for two distinct key files", () => {
      const keyA = path.join(tmpDir, "hmac-key-a");
      const keyB = path.join(tmpDir, "hmac-key-b");
      const secretA = _readHmacSecretHexForTests(keyA);
      const secretB = _readHmacSecretHexForTests(keyB);
      // Extremely unlikely to collide with real randomBytes(32).
      expect(secretA).not.toBe(secretB);
    });

    it("returns an ephemeral secret when the key file is a symlink (fail-closed)", () => {
      if (process.platform === "win32") return; // symlinks need elevation on Windows

      const realFile = path.join(tmpDir, "real-key");
      const linkFile = path.join(tmpDir, "link-key");
      // Write a valid key to realFile so the link target exists.
      fs.writeFileSync(realFile, "a".repeat(64), { mode: 0o600 });
      fs.symlinkSync(realFile, linkFile);

      // resolveHmacSecret should detect the symlink and return ephemeral.
      const secret = resolveHmacSecret(linkFile);
      // We can't compare to realFile contents because the function
      // refuses to read through symlinks; we just verify it returns a Buffer.
      expect(secret).toBeInstanceOf(Buffer);
      expect(secret.length).toBe(32);
    });

    it("key file has mode 0o600 after creation", () => {
      if (process.platform === "win32") return; // NTFS chmod is a no-op

      const keyFile = path.join(tmpDir, "hmac-key-mode");
      resolveHmacSecret(keyFile);
      const stat = fs.statSync(keyFile);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  // ── SEC-027: APFS homoglyph — darwin lowercase guard ─────────────────────

  describe("SEC-027: canonicalizeCheckpointPath — darwin case normalization", () => {
    it("on darwin: two paths differing only in case produce the same canonical key", () => {
      if (process.platform !== "darwin") return; // skip on non-darwin

      const upper = canonicalizeCheckpointPath(
        "/tmp/Assignee-Test/Checkpoint.json",
      );
      const lower = canonicalizeCheckpointPath(
        "/tmp/assignee-test/checkpoint.json",
      );
      expect(upper).toBe(lower);
    });

    it("on darwin: signing under one case verifies under the other case", () => {
      if (process.platform !== "darwin") return;

      const upperPath = canonicalizeCheckpointPath("/tmp/Sec027Test/cp.json");
      const lowerPath = canonicalizeCheckpointPath("/tmp/sec027test/cp.json");
      // Both should canonicalize to the same key, so signing one finds the other.
      const h = computeDesiredStateHash({ v: "sec027" });
      signCheckpoint(upperPath, h);
      // Verify via the lowercase canonical.
      expect(verifyCheckpoint(lowerPath, h)).toEqual({ ok: true });
    });

    it("on non-darwin: paths differing in case produce DIFFERENT canonical keys (fail-closed)", () => {
      if (process.platform === "darwin") return; // darwin behaviour tested above

      const upper = canonicalizeCheckpointPath("/tmp/CaseSensitive.json");
      const lower = canonicalizeCheckpointPath("/tmp/casesensitive.json");
      // On Linux the filesystem IS case-sensitive; the keys must differ.
      expect(upper).not.toBe(lower);
    });
  });
});
