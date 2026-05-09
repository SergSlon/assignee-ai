/**
 * Ensure the per-user `~/.assignee` directory exists with mode 0o700.
 *
 * **Why this helper exists**
 * --------------------------
 * `fs.mkdirSync(parent, { recursive: true, mode: 0o700 })` only applies
 * `mode` to the LEAF directory it actually creates. When the immediate
 * parent (`~/.assignee`) already exists, the `mode` option is silently
 * ignored — the parent keeps the umask-derived bits (typically `0o755`).
 *
 * The audit-key writer in `hmac-chain.ts` (SEC-005) detected the mode
 * mismatch and printed a warning every run, but the warning was the only
 * recourse — no auto-fix, no chmod attempt. This helper:
 *   1. Creates `~/.assignee` if absent at mode 0o700.
 *   2. Calls `chmodSync(dir, 0o700)` to relock pre-existing directories.
 *   3. Wraps the chmod in try/catch — read-only filesystems / Windows
 *      hosts simply get a warning, not a thrown error. Audit data is
 *      never lost because of a permission-relock failure.
 *
 * Idempotent: calling repeatedly with an already-0700 directory is a
 * no-op (mkdirSync recursive returns silently, chmodSync to the same
 * mode is a no-op syscall).
 *
 * Used by: `audit-log.ts`, `logger/paths.ts`, `checkpoint/store.ts`,
 * `ssh-keypair.ts`, and the SEC-005 detector in `hmac-chain.ts` (which
 * now auto-fixes before warning).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ASSIGNEE_DIR } from "../config/cfn-keys/paths.js";

/**
 * Resolve the absolute path of the per-user `~/.assignee` directory.
 *
 * Exported so tests can scope HOME to a tempdir and inspect the resolved
 * path under it without re-implementing the join.
 */
export function resolveAssigneeHomeDir(): string {
  return path.join(os.homedir(), ASSIGNEE_DIR);
}

/**
 * Internal seam: parts of the filesystem the helper interacts with.
 * Exposed so tests can substitute an in-memory mock without paying the
 * ESM "namespace not configurable" cost of `vi.spyOn(fs, "chmodSync")`.
 *
 * Production callers never pass this — the default is the real
 * `node:fs` API.
 */
export interface EnsureAssigneeHomeDirFs {
  mkdirSync: (dir: string, options: { recursive: true; mode: number }) => void;
  chmodSync: (dir: string, mode: number) => void;
}

const defaultFs: EnsureAssigneeHomeDirFs = {
  mkdirSync: (dir, options) => {
    fs.mkdirSync(dir, options);
  },
  chmodSync: (dir, mode) => {
    fs.chmodSync(dir, mode);
  },
};

/**
 * Ensure the user's `~/.assignee` directory exists at mode 0o700.
 *
 * Steps:
 *   1. `mkdirSync(dir, { recursive: true, mode: 0o700 })` — creates the
 *      directory if absent. When it already exists, this is a no-op
 *      and the existing mode is NOT changed (this is the bug the helper
 *      exists to compensate for).
 *   2. `chmodSync(dir, 0o700)` — explicitly relocks the directory. This
 *      is the load-bearing step for pre-existing directories.
 *
 * Both syscalls are wrapped in try/catch so a non-POSIX filesystem
 * (Windows NTFS, read-only mount) doesn't crash audit/logging writes.
 * Failures emit a structured stderr warning and return — callers should
 * never short-circuit their own work on a permission-relock failure.
 *
 * @param dir - Override the resolved path (used by tests).
 * @param fsImpl - Override the fs primitives (used by tests; defaults
 *   to `node:fs` which is what production callers want).
 */
export function ensureAssigneeHomeDir(
  dir: string = resolveAssigneeHomeDir(),
  fsImpl: EnsureAssigneeHomeDirFs = defaultFs,
): void {
  try {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    // ENOENT/EACCES on the *parent* of `dir` (i.e. HOME itself denies
    // mkdir) is unusual but not fatal — let the caller carry on. The
    // chmod below will throw the same class of error and we'll warn there.
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        event: "assignee-home-dir-mkdir-failed",
        dir,
        error: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
    return;
  }

  // Skip chmod on Windows — NTFS does not honour POSIX mode bits and the
  // syscall would be either a no-op (newer Node) or throw EPERM (older).
  if (process.platform === "win32") return;

  try {
    fsImpl.chmodSync(dir, 0o700);
  } catch (err) {
    // Read-only filesystem, EPERM (file owned by another uid), or other
    // non-recoverable filesystem state. Emit ONE warning and continue —
    // the audit log / checkpoint / log writer will still proceed; the
    // mode mismatch is a defence-in-depth concern, not a correctness one.
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        event: "assignee-home-dir-chmod-failed",
        dir,
        error: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
  }
}
