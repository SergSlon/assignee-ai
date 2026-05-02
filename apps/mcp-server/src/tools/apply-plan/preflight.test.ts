/**
 * Unit tests for apply-plan/preflight.ts
 *
 * Covers the three guard functions:
 *   - checkConfirmedGate  (existing logic)
 *   - checkCheckpointPath (existing logic)
 *   - checkCheckpointSymlink (SEC-020 — symlink rejection at LOAD time)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCheckpointPath,
  checkCheckpointSymlink,
  checkConfirmedGate,
} from "./preflight.js";

// ── Temp-dir fixture ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── checkConfirmedGate ────────────────────────────────────────────────────────

describe("checkConfirmedGate", () => {
  it("returns null when confirmed=true (gate passes)", () => {
    expect(checkConfirmedGate(true)).toBeNull();
  });

  it("returns an error envelope when confirmed=false (gate fails)", () => {
    const result = checkConfirmedGate(false);
    expect(result).not.toBeNull();
    expect(result?.content[0]?.text).toContain("confirmed: true");
  });
});

// ── checkCheckpointPath ───────────────────────────────────────────────────────

describe("checkCheckpointPath", () => {
  it("returns null for a valid absolute path with no '..' (passes)", () => {
    expect(checkCheckpointPath("/tmp/checkpoint.json")).toBeNull();
  });

  it("rejects a relative path", () => {
    const result = checkCheckpointPath("./checkpoint.json");
    expect(result).not.toBeNull();
    expect(result?.content[0]?.text).toContain("absolute path");
  });

  it("rejects a path containing '..' segments", () => {
    const result = checkCheckpointPath("/tmp/../etc/passwd");
    expect(result).not.toBeNull();
    expect(result?.content[0]?.text).toContain("traversal");
  });

  it("rejects a bare relative filename", () => {
    const result = checkCheckpointPath("checkpoint.json");
    expect(result).not.toBeNull();
    expect(result?.content[0]?.text).toContain("absolute path");
  });
});

// ── checkCheckpointSymlink (SEC-020) ─────────────────────────────────────────

describe("SEC-020: checkCheckpointSymlink", () => {
  it("returns { ok: true } for a plain file (no symlink)", () => {
    const filePath = path.join(tmpDir, "plain-checkpoint.json");
    fs.writeFileSync(filePath, '{"test":true}', { mode: 0o600 });

    const result = checkCheckpointSymlink(filePath);
    expect(result).toEqual({ ok: true });
  });

  it("returns { ok: false, reason: 'not-found' } when the file does not exist", () => {
    const filePath = path.join(tmpDir, "nonexistent.json");
    const result = checkCheckpointSymlink(filePath);
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("returns { ok: false, reason: 'symlink-detected' } for a symlink pointing to a real file", () => {
    if (process.platform === "win32") return; // symlinks need elevation on Windows

    const realFile = path.join(tmpDir, "real-checkpoint.json");
    const symlinkPath = path.join(tmpDir, "link-checkpoint.json");

    // Create a real file, then symlink to it.
    fs.writeFileSync(realFile, '{"test":true}', { mode: 0o600 });
    fs.symlinkSync(realFile, symlinkPath);

    const result = checkCheckpointSymlink(symlinkPath);
    expect(result).toEqual({ ok: false, reason: "symlink-detected" });
  });

  it("returns { ok: true } for a file inside a directory that is a symlink (directory symlinks are OS-level and not attacker-relevant)", () => {
    if (process.platform === "win32") return;

    const realDir = path.join(tmpDir, "real-dir");
    const linkDir = path.join(tmpDir, "link-dir");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir);

    // Create the file under the REAL directory (accessed via the symlinked dir path).
    const filePath = path.join(linkDir, "checkpoint.json");
    fs.writeFileSync(path.join(realDir, "checkpoint.json"), '{"test":true}', {
      mode: 0o600,
    });

    // The file at `filePath` (lstat of linkDir/checkpoint.json) is NOT a
    // symlink — it's a regular file. Only a SYMLINK at the file location
    // itself (not a parent directory) is rejected.
    const result = checkCheckpointSymlink(filePath);
    // lstatSync resolves linkDir/checkpoint.json -> the real file in realDir
    // (lstat sees the real file, not a symlink). This is acceptable behaviour.
    expect(result).toEqual({ ok: true });
  });

  it("accepts a path inside a real directory (no symlink anywhere in chain)", () => {
    const subDir = path.join(tmpDir, "checkpoints");
    fs.mkdirSync(subDir);
    const filePath = path.join(subDir, "cp-001.json");
    fs.writeFileSync(filePath, '{"step":"plan"}', { mode: 0o600 });

    const result = checkCheckpointSymlink(filePath);
    expect(result).toEqual({ ok: true });
  });
});
