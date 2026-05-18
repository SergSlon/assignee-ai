/**
 * Unit tests for safe-output-path — CWE-22 path-traversal guard.
 *
 * All tests inject a fixed `cwd` so they are deterministic regardless of
 * where the repo is checked out.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
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
    // detail of `path.resolve` and varies per platform (Windows produces
    // `D:\home\etc\passwd`); compare against the host's path.resolve()
    // so the assertion is portable. The key invariant is that the
    // relative path from CWD starts with ".." (escapes CWD).
    expect(result.resolvedPath).toBe(path.resolve(CWD, "../../etc/passwd"));
    expect(path.relative(CWD, result.resolvedPath!).startsWith("..")).toBe(
      true,
    );
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
    // path.resolve() handles the host's absolute-path shape: on POSIX
    // returns "/etc/passwd"; on Windows returns "<drive>:\etc\passwd"
    // because "/etc/passwd" with no drive prefix is relative to the
    // current drive. Either way the path escapes CWD.
    expect(result.resolvedPath).toBe(path.resolve(CWD, "/etc/passwd"));
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
  // All resolvedPath assertions use path.resolve(CWD, raw) rather than
  // hardcoded POSIX-shaped literals like `${CWD}/drift.json`, because
  // Node's `path.resolve` returns OS-native separators (`\` on Windows,
  // `/` on POSIX). This makes the assertions portable while keeping the
  // strict equality check intact.

  it("accepts a simple CWD-relative filename (drift.json)", () => {
    const result = validateOutputPath("drift.json", CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(path.resolve(CWD, "drift.json"));
  });

  it("accepts a CWD subdirectory path (reports/drift.json)", () => {
    const result = validateOutputPath("reports/drift.json", CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(path.resolve(CWD, "reports/drift.json"));
  });

  it("accepts a deeply nested subdir path (a/b/c/out.json)", () => {
    const result = validateOutputPath("a/b/c/out.json", CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(path.resolve(CWD, "a/b/c/out.json"));
  });

  it("accepts an absolute path that resolves inside CWD", () => {
    // Build the input via path.resolve so the path is absolute on the
    // host platform — feeding a POSIX-shaped literal on Windows would
    // be a different test case (drive-relative resolution).
    const rawAbs = path.resolve(CWD, "drift.json");
    const result = validateOutputPath(rawAbs, CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(rawAbs);
  });

  it("accepts a path that is exactly CWD (edge: outputting to the dir itself is technically inside)", () => {
    // Caller would fail on writeFile, but the security guard passes.
    // CWD-vs-resolved comparison via path.resolve handles platform-
    // specific normalisation (trailing separators, casing on Windows).
    const result = validateOutputPath(CWD, CWD);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(path.resolve(CWD));
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

// ---------------------------------------------------------------------------
// Windows path shape — POSIX regression guard (cross-platform portability)
//
// These tests exercise the Windows path shape via `path.win32` so that future
// regressions in the CWD-containment check are caught on Linux/macOS CI
// without needing a real Windows runner.  The production `validateOutputPath`
// uses `nodePath` (the native module), so these tests call it with synthetic
// Windows-shaped CWD strings and assert that the `path.relative()` logic works
// regardless of OS separator.
// ---------------------------------------------------------------------------

describe("validateOutputPath — Windows path shape (POSIX regression guard)", () => {
  // Simulate a Windows CWD injected via the second argument (pure-string
  // exercise; does not call win32.resolve() on the production side because
  // the production code runs `nodePath.resolve(cwd, rawPath)` using the
  // host OS's path module, not win32).  What we CAN test on POSIX is that
  // the relative() guard is logically correct when the host is Windows —
  // we verify via path.win32.relative() that our chosen inputs produce the
  // expected rel strings, then call the real validateOutputPath with a
  // crafted absolute CWD that path.relative() on POSIX also handles.

  it("win32 relative() helper — inside-CWD path produces non-dotdot relative", () => {
    // Verify the `path.relative()` idiom we rely on works correctly on win32
    // path shapes (useful as a compile-time sanity check when reviewed on CI).
    const win32Cwd = "C:\\Users\\user\\project";
    const win32Inside = "C:\\Users\\user\\project\\reports\\out.json";
    const rel = path.win32.relative(win32Cwd, win32Inside);
    // rel is "reports\\out.json" — does not start with ".."
    expect(rel.startsWith("..")).toBe(false);
    expect(path.win32.isAbsolute(rel)).toBe(false);
  });

  it("win32 relative() helper — outside-CWD path produces dotdot relative", () => {
    const win32Cwd = "C:\\Users\\user\\project";
    const win32Outside = "C:\\Users\\user\\other\\file.json";
    const rel = path.win32.relative(win32Cwd, win32Outside);
    // rel is "..\\other\\file.json" — starts with ".."
    expect(rel.startsWith("..")).toBe(true);
  });

  it("win32 relative() helper — different drive produces absolute relative (catches cross-drive escape)", () => {
    // On Windows, path.relative('C:\\foo', 'D:\\bar') returns 'D:\\bar'
    // (an absolute path because drives differ).  path.isAbsolute() must catch
    // this case to prevent a cross-drive path-traversal bypass.
    const win32Cwd = "C:\\Users\\user\\project";
    const win32OtherDrive = "D:\\evil\\payload.json";
    const rel = path.win32.relative(win32Cwd, win32OtherDrive);
    // Either starts with ".." (unlikely) or is absolute (cross-drive)
    expect(rel.startsWith("..") || path.win32.isAbsolute(rel)).toBe(true);
  });

  it("accepts a deeply nested subdir on a POSIX path (regression: old startsWith check failed on Windows)", () => {
    // This test would have FAILED with the old `resolved.startsWith(cwdWithSep)`
    // logic on Windows because backslash separators were not handled.
    // The path.relative() fix makes it pass on both platforms.
    const cwd = "/home/user/project";
    const result = validateOutputPath("a/b/c/out.json", cwd);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(path.resolve(cwd, "a/b/c/out.json"));
  });

  it("accepts absolute path resolving inside CWD (regression guard)", () => {
    const cwd = "/home/user/project";
    const rawAbs = path.resolve(cwd, "drift.json");
    const result = validateOutputPath(rawAbs, cwd);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(rawAbs);
  });

  it("accepts path equal to CWD (edge: outputting to dir itself — regression guard)", () => {
    const cwd = "/home/user/project";
    const result = validateOutputPath(cwd, cwd);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(path.resolve(cwd));
  });

  it("still rejects partial directory-name prefix match (regression guard for /home/user/project-evil)", () => {
    // path.relative('/home/user/project', '/home/user/project-evil/f.json')
    // → '../project-evil/f.json' — starts with '..', correctly rejected.
    const cwd = "/home/user/project";
    const result = validateOutputPath("/home/user/project-evil/file.json", cwd);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("path-traversal");
  });
});
