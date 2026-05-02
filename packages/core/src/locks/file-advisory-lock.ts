/**
 * W4-03 (Epic 100 Round 3) — FileAdvisoryLockAdapter.
 *
 * File-based implementation of AdvisoryLockPort. Acquires `<name>.lock`
 * via the StoragePort `tryAcquire(key, value)` method, which adapters
 * implement as an atomic create-if-not-exists (local-fs uses
 * O_CREAT|O_EXCL|O_WRONLY; S3/DDB adapters use their conditional-write
 * equivalents). The PID is written into the lock blob so debug tooling
 * can identify the holder.
 *
 * Stale-lock reclamation: if a `<name>.lock` key exists and its
 * last-modified timestamp is older than `staleLockTimeoutMs`
 * (default 10 seconds), the lock is considered stale and removed
 * before retrying.
 *
 * `withLock` retries with linear backoff up to `maxRetries` attempts.
 * If all retries are exhausted without acquiring the lock, a
 * `LockAcquisitionError` is thrown — `fn()` is never called without
 * the lock held.
 *
 * 0o600 on lock files: lock files are written with owner-only permissions
 * (enforced by the local-fs adapter's `tryAcquire`).
 *
 * RW4d-migration-B (M-016): every I/O path now goes through the
 * StoragePort. Cluster B follow-up (this file) replaced the previous
 * direct `fs.open` and `fs.stat` calls with `port.tryAcquire` and
 * `port.stat`, so the adapter is fully port-agnostic and works
 * against any storage backend that implements the interface.
 */

import * as path from "node:path";
import { LocalFsStorageAdapter } from "../adapters/storage/local-fs-adapter.js";
import type { AdvisoryLockPort } from "../ports/advisory-lock-port.js";
import type { StoragePort } from "../ports/storage-port.js";

// ── LockAcquisitionError ──────────────────────────────────────────────

/**
 * Thrown by `withLock` when all retry attempts to acquire the lock are
 * exhausted. The caller can catch this to implement a fallback strategy
 * appropriate for their domain (e.g. abort, alert, queue the work).
 *
 * `instanceof LockAcquisitionError` is the recommended check pattern.
 */
export class LockAcquisitionError extends Error {
  override readonly name = "LockAcquisitionError";
  constructor(lockName: string, attempts: number) {
    super(
      `Failed to acquire advisory lock "${lockName}" after ${attempts} attempt(s).`,
    );
  }
}

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

/**
 * Resolve the StoragePort to use for the given lock `name`.
 *
 * `name` is an arbitrary path-like string (callers pass absolute paths
 * such as `path.join(tmpDir, "counter")`). Different locks may live in
 * different parent directories, so we cannot build a single
 * `LocalFsStorageAdapter` once at construction time and reuse it across
 * acquire/release calls. When no explicit StoragePort is supplied we
 * build a transient adapter rooted at `dirname(<name>.lock)` per call,
 * with the lock filename as the key. This mirrors `loader.ts` from
 * RW4d-migration-A.
 */
function resolvePortForLock(
  name: string,
  storage: StoragePort | undefined,
): { port: StoragePort; key: string } {
  const lp = lockPath(name);
  const key = path.basename(lp);
  const port =
    storage ?? new LocalFsStorageAdapter({ rootDir: path.dirname(lp) });
  return { port, key };
}

// ── FileAdvisoryLockAdapter ───────────────────────────────────────────

export class FileAdvisoryLockAdapter implements AdvisoryLockPort {
  private readonly staleLockTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly storage: StoragePort | undefined;

  constructor(
    options: {
      staleLockTimeoutMs?: number;
      maxRetries?: number;
      retryDelayMs?: number;
      // TODO(SaaS): require StoragePort once all callers thread it through.
      storage?: StoragePort;
    } = {},
  ) {
    this.staleLockTimeoutMs =
      options.staleLockTimeoutMs ?? FILE_LOCK_STALE_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? FILE_LOCK_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? FILE_LOCK_RETRY_DELAY_MS;
    this.storage = options.storage;
  }

  /**
   * Attempt to acquire the lock at `<name>.lock`.
   * Returns `true` on success, `false` if another holder is active.
   *
   * Stale-lock check uses `port.stat(key).lastModifiedMs`; the atomic
   * create uses `port.tryAcquire(key, pidBytes)`. Both go through the
   * StoragePort so the adapter is fully storage-agnostic.
   */
  async acquire(name: string): Promise<boolean> {
    const { port, key } = resolvePortForLock(name, this.storage);

    // Stale-lock probe via port.stat. Wrap in try/catch so EACCES /
    // EROFS / EIO from the adapter doesn't escape to withLock callers
    // (matches the pre-cluster-B fs.stat-based code path's defensive
    // posture — bug-hunt R4 B-1).
    let existing: { lastModifiedMs: number } | undefined;
    try {
      existing = await port.stat(key);
    } catch {
      existing = undefined;
    }
    if (existing !== undefined) {
      const ageMs = Date.now() - existing.lastModifiedMs;
      if (ageMs < this.staleLockTimeoutMs) {
        return false; // Lock is fresh — another holder is active.
      }
      // Stale — remove via the port and proceed to create.
      await port.delete(key).catch(() => {});
    }

    const pidBytes = new TextEncoder().encode(String(process.pid));
    try {
      return await port.tryAcquire(key, pidBytes);
    } catch {
      return false; // Adapter-level failure treated as lost race.
    }
  }

  /**
   * Release the lock at `<name>.lock`. No-op when the file does not exist.
   *
   * Goes through the StoragePort `delete(key)` so future remote
   * adapters can hook in here without further refactor.
   */
  async release(name: string): Promise<void> {
    const { port, key } = resolvePortForLock(name, this.storage);
    await port.delete(key).catch(() => {});
  }

  /**
   * Acquire the lock, run `fn`, release in a try/finally block.
   *
   * Retries acquisition with `retryDelayMs` pauses between attempts.
   * Throws `LockAcquisitionError` when the retry budget is exhausted —
   * `fn()` is NEVER called without the lock held (prevents corrupted
   * HMAC-chain writes under concurrent load).
   *
   * ## Structured stderr events (PR-018, W24c-S2)
   *
   * Two JSON-newline events are emitted to `process.stderr` during lock
   * contention. Log aggregators (Datadog, CloudWatch Logs Insights, jq)
   * can parse these directly.
   *
   * ### `lock_contention` — emitted on every failed acquisition attempt
   *
   * ```json
   * {
   *   "event":    "lock_contention",
   *   "lockName": "/absolute/path/to/counter",
   *   "attempt":  1,
   *   "pid":      12345
   * }
   * ```
   *
   * | Field      | Type   | Description                                          |
   * |------------|--------|------------------------------------------------------|
   * | `event`    | string | Always `"lock_contention"`                           |
   * | `lockName` | string | The `name` argument passed to `withLock`             |
   * | `attempt`  | number | 1-based retry index (1 = first failed attempt)       |
   * | `pid`      | number | PID of the process waiting for the lock              |
   *
   * ### `lock_acquisition_failed` — emitted on final failure before throw
   *
   * ```json
   * {
   *   "event":      "lock_acquisition_failed",
   *   "lockName":   "/absolute/path/to/counter",
   *   "attempts":   21,
   *   "pid":        12345,
   *   "holderStat": { "mtime": "2026-04-29T10:00:00.000Z", "size": 5 }
   * }
   * ```
   *
   * | Field              | Type           | Description                                               |
   * |--------------------|----------------|-----------------------------------------------------------|
   * | `event`            | string         | Always `"lock_acquisition_failed"`                        |
   * | `lockName`         | string         | The `name` argument passed to `withLock`                  |
   * | `attempts`         | number         | Total attempts made (`maxRetries + 1`)                    |
   * | `pid`              | number         | PID of the process that failed to acquire                 |
   * | `holderStat`       | object \| `{}` | Lock-file stat at final failure; `{}` if stat unavailable |
   * | `holderStat.mtime` | string         | ISO 8601 last-modified timestamp of the lock file         |
   * | `holderStat.size`  | number         | Byte size of the lock file (contains the holder's PID)    |
   *
   * After emitting `lock_acquisition_failed`, `LockAcquisitionError` is thrown.
   */
  async withLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    let acquired = false;
    // maxRetries=0 means one attempt (loop body always runs at least once
    // to give a single acquisition chance before giving up).
    const totalAttempts = this.maxRetries + 1;

    for (let i = 0; i < totalAttempts; i++) {
      acquired = await this.acquire(name);
      if (acquired) break;
      // Emit contention warning on every retry so operators have breadcrumbs
      // when concurrent processes (CI matrix, IDE + CLI) collide on the lock.
      process.stderr.write(
        JSON.stringify({
          event: "lock_contention",
          lockName: name,
          attempt: i + 1,
          pid: process.pid,
        }) + "\n",
      );
      if (i < totalAttempts - 1) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.retryDelayMs),
        );
      }
    }

    if (!acquired) {
      // Emit acquisition-failed event with lock-file stat for post-mortem.
      const lockFilePath = `${name}.lock`;
      let holderInfo: { mtime?: string; size?: number } = {};
      try {
        const st = await import("node:fs").then((m) =>
          m.statSync(lockFilePath),
        );
        holderInfo = {
          mtime: new Date(st.mtimeMs).toISOString(),
          size: st.size,
        };
      } catch {
        // stat failure is non-fatal — lock file may already be gone
      }
      process.stderr.write(
        JSON.stringify({
          event: "lock_acquisition_failed",
          lockName: name,
          attempts: totalAttempts,
          pid: process.pid,
          holderStat: holderInfo,
        }) + "\n",
      );
      throw new LockAcquisitionError(name, totalAttempts);
    }

    try {
      return await fn();
    } finally {
      await this.release(name);
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
