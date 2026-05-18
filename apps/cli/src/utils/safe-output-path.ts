/**
 * safe-output-path — CWE-22 path-traversal guard for `--output-file` flags.
 *
 * Exported as a pure function so any CLI command that accepts an
 * `--output-file` option can reuse the same validation logic.
 *
 * Design choices:
 * - Validation is lexical: we use `path.resolve(cwd, p)` rather than
 *   `fs.realpath` to avoid TOCTOU races and to work on paths that don't
 *   exist yet (the file will be created by the caller).
 * - Absolute paths that resolve to inside CWD are accepted; those that
 *   resolve outside CWD are rejected (CWE-22 defence).
 * - Empty / undefined input is treated as "no output file requested"
 *   and returns `{ ok: true }` so callers can wrap the whole
 *   `if (opts.outputFile)` block without needing an additional null check.
 * - NUL bytes are rejected before any path resolution (OS-level attack
 *   vector; Node's own `fs` module would throw, but we prefer a
 *   controlled, user-facing message).
 */

import * as nodePath from "node:path";

export interface SafeOutputPathResult {
  /** True when the path is safe to use; false when rejected. */
  ok: boolean;
  /**
   * The OS-resolved absolute path that was checked.
   * Present for both accepted and rejected results (useful in error messages).
   * Undefined only when `rawPath` was empty/undefined (no-op case).
   */
  resolvedPath?: string;
  /** Human-readable rejection reason; undefined when ok === true. */
  reason?: string;
}

/**
 * Validate a user-supplied `--output-file` path against CWE-22 rules.
 *
 * @param rawPath  The raw string value from the CLI option (may be undefined).
 * @param cwd      The working directory to resolve against (defaults to
 *                 `process.cwd()`). Injected for testability.
 * @returns        A `SafeOutputPathResult` describing the decision.
 */
export function validateOutputPath(
  rawPath: string | undefined,
  cwd: string = process.cwd(),
): SafeOutputPathResult {
  // No-op: caller's `if (opts.outputFile)` guard is still the primary check;
  // returning ok=true for empty input lets callers call this unconditionally.
  if (!rawPath) {
    return { ok: true };
  }

  // Reject NUL bytes — Node fs would throw ENOENT/EINVAL, but we prefer
  // a controlled message before any syscall.
  if (rawPath.includes("\0")) {
    return {
      ok: false,
      reason:
        "Output path contains a NUL byte. Provide a plain file path without embedded null characters.",
    };
  }

  const resolved = nodePath.resolve(cwd, rawPath);

  // Portable inside-CWD check using path.relative() — avoids string-prefix
  // comparison which is broken on Windows when CWD uses backslashes but the
  // comparison string uses forward slashes (or drive-letter casing differs).
  //
  // path.relative(cwd, resolved) returns:
  //   ""              → resolved IS the cwd
  //   "foo/bar"       → resolved is inside cwd
  //   "../sibling"    → resolved escapes cwd  (starts with "..")
  //   "/abs/path"     → path.relative returns an absolute path on Windows
  //                     when the resolved path is on a different drive; this
  //                     is caught by the path.isAbsolute() guard below.
  const rel = nodePath.relative(cwd, resolved);
  const isInsideCwd =
    rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));

  if (!isInsideCwd) {
    return {
      ok: false,
      resolvedPath: resolved,
      reason: `Output path resolves outside the current working directory and was rejected to prevent path-traversal.\n  Resolved path : ${resolved}\n  Working dir   : ${cwd}\n  Tip: use a relative path such as "drift.json" or "reports/drift.json".`,
    };
  }

  return { ok: true, resolvedPath: resolved };
}
