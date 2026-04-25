/**
 * W4-03 (Epic 100 Round 3) — FileAdvisoryLockAdapter.
 *
 * File-based implementation of AdvisoryLockPort. Creates a `<name>.lock`
 * file using O_CREAT|O_EXCL|O_WRONLY for atomic lock acquisition (same
 * technique as `packages/core/src/services/memory/file-store.ts`).
 *
 * Stale-lock reclamation: if a `.lock` file exists and its mtime is
 * older than `staleLockTimeoutMs` (default 10 seconds), the lock is
 * considered stale and removed before retrying.
 *
 * `withLock` retries with linear backoff up to `maxRetries` attempts
 * before falling back to calling `fn` without the lock (advisory
 * semantics — the lock is a best-effort coordination mechanism, not a
 * hard POSIX mutex).
 *
 * 0o600 on lock files: lock files are written with owner-only permissions.
 */

import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { AdvisoryLockPort } from "./advisory-lock-port.js";

// ── Defaults ──────────────────────────────────────────────────────────

/** Default stale-lock timeout (ms). Locks older than this are reclaimed. */
export const FILE_LOCK_STALE_TIMEOUT_MS = 10_000;

/** Default retry count for `withLock`. */
export const FILE_LOCK_MAX_RETRIES = 20;

/** Default initial retry delay (ms). Doubles each iteration (linear for now). */
export const FILE_LOCK_RETRY_DELAY_MS = 50;

// ── Lock file path helper ─────────────────────────────────────────────

/** Returns the lock file path for a given lock name. */
function lockPath(name: string): string {
  return `${name}.lock`;
}

// ── FileAdvisoryLockAdapter ───────────────────────────────────────────

export class FileAdvisoryLockAdapter implements AdvisoryLockPort {
  private readonly staleLockTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    options: {
      staleLockTimeoutMs?: number;
      maxRetries?: number;
      retryDelayMs?: number;
    } = {},
  ) {
    this.staleLockTimeoutMs =
      options.staleLockTimeoutMs ?? FILE_LOCK_STALE_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? FILE_LOCK_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? FILE_LOCK_RETRY_DELAY_MS;
  }

  /**
   * Attempt to acquire the lock at `<name>.lock`.
   * Returns `true` on success, `false` if another holder is active.
   */
  async acquire(name: string): Promise<boolean> {
    const lp = lockPath(name);

    // Check for stale lock.
    try {
      const stat = await fs.stat(lp);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < this.staleLockTimeoutMs) {
        return false; // Lock is fresh — another holder is active.
      }
      // Stale — remove it.
      await fs.unlink(lp).catch(() => {});
    } catch {
      // No lock file → proceed to create.
    }

    // Atomic creation with O_CREAT|O_EXCL to prevent TOCTOU races.
    try {
      const fh = await fs.open(
        lp,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      await fh.write(String(process.pid));
      await fh.close();
      return true;
    } catch {
      return false; // EEXIST or other error — another process won the race.
    }
  }

  /**
   * Release the lock at `<name>.lock`. No-op when the file does not exist.
   */
  async release(name: string): Promise<void> {
    await fs.unlink(lockPath(name)).catch(() => {});
  }

  /**
   * Acquire the lock, run `fn`, release in a try/finally block.
   *
   * Retries acquisition with `retryDelayMs` pauses between attempts.
   * Falls back to calling `fn` without the lock when the retry budget
   * is exhausted (advisory lock — best-effort coordination only).
   */
  async withLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    let acquired = false;

    for (let i = 0; i < this.maxRetries; i++) {
      acquired = await this.acquire(name);
      if (acquired) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.retryDelayMs),
      );
    }

    try {
      return await fn();
    } finally {
      if (acquired) {
        await this.release(name);
      }
    }
  }
}

// ── Module-level default instance ─────────────────────────────────────

/**
 * Default FileAdvisoryLockAdapter instance. Used by memory-recorder.ts
 * and provision-record.ts to serialize concurrent writes to shared JSON
 * files. The default parameters are appropriate for the expected concurrency
 * on a developer machine (< 10 concurrent writers, local SSD).
 */
export const defaultFileAdvisoryLock = new FileAdvisoryLockAdapter();
