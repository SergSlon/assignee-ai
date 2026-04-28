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
 *
 * RW4d-migration-B (M-016): the adapter now accepts an optional
 * `StoragePort` for the release path (delete-by-key) and the existence
 * check used during stale-lock detection. The acquire path
 * deliberately retains the legacy `node:fs` `O_EXCL` open call: see
 * the FLAG block below for why no StoragePort method maps cleanly to
 * atomic create-if-not-exists. Stale-lock reclamation also continues
 * to read `mtime` via `node:fs` directly because StoragePort exposes
 * no `stat(key)` accessor today (same FLAG documented in
 * `pruner.ts`).
 *
 * FLAGs for StoragePort follow-up extension:
 *
 * 1. ATOMIC CREATE-IF-NOT-EXISTS — `acquire` relies on
 *    `O_CREAT|O_EXCL|O_WRONLY` to win the race against a concurrent
 *    acquirer. StoragePort has no equivalent: `writeBytes(key, value)`
 *    always overwrites, and the `has(key) -> writeBytes(key)` pair has
 *    a TOCTOU window. A future `tryAcquire(key, value)` /
 *    `writeBytesIfAbsent(key, value)` port method (returning `true` on
 *    create, `false` when the key already exists) would let the
 *    acquire path go through the port. Today the acquire path uses
 *    `node:fs` directly even when an explicit `storage` is supplied —
 *    fine for `LocalFsStorageAdapter` whose data is on the same
 *    filesystem; future S3/DDB adapters will need the port extension
 *    before this becomes adapter-agnostic. (Advisory semantics tolerate
 *    a best-effort fallback if the SaaS lift wants to live with the
 *    TOCTOU window before the extension lands.)
 *
 * 2. MTIME-BASED STALENESS — stale-lock detection reads
 *    `fs.stat(lockPath).mtimeMs`. StoragePort exposes no
 *    `stat(key)`/`lastModified` accessor. Same FLAG as `pruner.ts`
 *    already raised. Future remote adapters (S3 LastModified, DDB
 *    ttl) will need a port extension before this guard can be
 *    honoured cleanly.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LocalFsStorageAdapter } from "../adapters/storage/local-fs-adapter.js";
import type { AdvisoryLockPort } from "../ports/advisory-lock-port.js";
import type { StoragePort } from "../ports/storage-port.js";

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
   * Stale-lock check uses the StoragePort `has(key)` for existence,
   * but the freshness probe still reads `mtime` via `node:fs` directly
   * (FLAG 2 — port has no `stat(key)`). The atomic create itself uses
   * `node:fs` `O_EXCL` (FLAG 1 — port has no atomic
   * create-if-not-exists). When the supplied port is a
   * `LocalFsStorageAdapter` (the only adapter today) both fall-throughs
   * still hit the same filesystem, so the wire-level behaviour matches
   * the pre-migration code byte-for-byte.
   */
  async acquire(name: string): Promise<boolean> {
    const lp = lockPath(name);
    const { port, key } = resolvePortForLock(name, this.storage);

    // Check for stale lock.
    if (await port.has(key)) {
      // Freshness probe — `mtime` is not exposed by StoragePort, so
      // we read directly via `node:fs`. See FLAG 2.
      try {
        const stat = await fs.stat(lp);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < this.staleLockTimeoutMs) {
          return false; // Lock is fresh — another holder is active.
        }
      } catch {
        // Race: lock disappeared between has() and stat() — treat as
        // not-held and proceed to create.
      }
      // Stale (or vanished mid-check) — remove via the port.
      await port.delete(key).catch(() => {});
    }

    // Atomic creation with O_CREAT|O_EXCL to prevent TOCTOU races.
    // FLAG 1: StoragePort has no atomic create-if-not-exists; we
    // therefore call node:fs directly here. A future port extension
    // (`tryAcquire`/`writeBytesIfAbsent`) would let this go through
    // the port for remote adapters.
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
