/**
 * Unit tests for safe-output-path — CWE-22 path-traversal guard.
 *
 * All tests inject a fixed `cwd` so they are deterministic regardless of
 * where the repo is checked out.
 */

import { describe, it, expect } from "vitest";
import { validateOutputPath } from "./safe-output-path.js";

const CWD = "/home/user/project";

// ---------------------------------------------------------------------------
// Rejection cases
// ---------------------------------------------------------------------------

describe("validateOutputPath — rejection", () => {
  it("rejects relative path-traversal escape (../../etc/passwd)", () => {
    const result = validateOutputPath("../../etc/passwd", CWD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("path-traversal");
    // From CWD=/home/user/project, two `..` levels up resolves to /home,
    // then `etc/passwd` lands at /home/etc/passwd — outside CWD, hence
    // correctly rejected. The exact resolved string is implementation
    // detail of `path.resolve`; the key invariant is that it does NOT
    // start with the CWD prefix.
    expect(result.resolvedPath).toBe("/home/etc/passwd");
    expect(result.resolvedPath?.startsWith(CWD + "/")).toBe(false);
  });

  it("rejects single-level traversal (../sibling/file.json)", () => {
    const result = validateOutputPath("../sibling/file.json", CWD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("path-traversal");
  });

  it("rejects absolute path that escapes CWD (/etc/passwd)", () => {
    const result = validateOutputPath("/etc/passwd", CWD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("path-traversal");
    expect(result.resolvedPath).toBe("/etc/passwd");
  });

  it("rejects absolute path to /tmp (outside CWD)", () => {
    const result = validateOutputPath("/tmp/output.json", CWD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("path-traversal");
  });

  it("rejects path with NUL byte (valid\\0../../etc/passwd)", () => {
    const result = validateOutputPath("valid\0../../etc/passwd", CWD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("NUL byte");
    // resolvedPath should be absent — we reject before resolution
    expect(result.resolvedPath).toBeUndefined();
  });

  it("rejects path with NUL byte at the start", () => {
    const result = validateOutputPath("\0output.json", CWD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("NUL byte");
  });

  it("rejects partial directory-name prefix match (/home/user/project-evil)", () => {
    // Lexical check: /home/user/project-evil starts with /home/user/project
    // but NOT with /home/user/project/ — must be rejected.
    const result = validateOutputPath("/home/user/project-evil/file.json", CWD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("path-traversal");
  });
});

// ---------------------------------------------------------------------------
// Acceptance cases
// ---------------------------------------------------------------------------

describe("validateOutputPath — acceptance", () => {
  it("accepts a simple CWD-relative filename (drift.json)", () => {
    const result = validateOutputPath("drift.json", CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(`${CWD}/drift.json`);
  });

  it("accepts a CWD subdirectory path (reports/drift.json)", () => {
    const result = validateOutputPath("reports/drift.json", CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(`${CWD}/reports/drift.json`);
  });

  it("accepts a deeply nested subdir path (a/b/c/out.json)", () => {
    const result = validateOutputPath("a/b/c/out.json", CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(`${CWD}/a/b/c/out.json`);
  });

  it("accepts an absolute path that resolves inside CWD", () => {
    const result = validateOutputPath(`${CWD}/drift.json`, CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(`${CWD}/drift.json`);
  });

  it("accepts a path that is exactly CWD (edge: outputting to the dir itself is technically inside)", () => {
    // Caller would fail on writeFile, but the security guard passes.
    const result = validateOutputPath(CWD, CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(CWD);
  });
});

// ---------------------------------------------------------------------------
// No-op / empty input
// ---------------------------------------------------------------------------

describe("validateOutputPath — empty / undefined input", () => {
  it("returns ok=true for undefined (caller uses if-guard before writing)", () => {
    const result = validateOutputPath(undefined, CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it("returns ok=true for empty string", () => {
    const result = validateOutputPath("", CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Symlink-traversal hardening note
// ---------------------------------------------------------------------------
// Lexical resolution via path.resolve() covers the vast majority of
// path-traversal attacks (CWE-22) without requiring temp-symlink fixtures.
// OS-level symlink bypasses (where realpath differs from lexical path)
// would require fs.realpath and a pre-existence check; that is deferred to
// a follow-up hardening story since it introduces TOCTOU complexity and the
// primary CWE-22 vectors (../ sequences, absolute escapes, NUL bytes) are
// fully covered above.
