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

// ── SEC-022: audit-lock circuit-breaker ───────────────────────────────
// Per-path counter: consecutive LockAcquisitionErrors within a 60s window
// escalate to a structured stderr alarm after LOCK_ALARM_THRESHOLD failures.
const LOCK_ALARM_THRESHOLD = 3;
const LOCK_ALARM_WINDOW_MS = 60_000;

// F008: cap both counter Maps at 1000 entries (FIFO eviction on insertion).
// A long-running MCP server can touch thousands of unique lock paths; without
// a cap each path accumulates an entry forever. 1000 covers any realistic
// burst while keeping the Maps below ~200 KB of metadata.
const COUNTER_MAP_MAX_SIZE = 1_000;

function evictIfFull<V>(map: Map<string, V>): void {
  if (map.size >= COUNTER_MAP_MAX_SIZE) {
    // Delete the oldest (first-inserted) key — Map iteration order is
    // insertion order in V8/Node.js, so the first key is the oldest.
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
}

interface LockFailureRecord {
  count: number;
  windowStart: number; // epoch ms of first failure in this window
  alarmed: boolean; // true once the alarm has fired this window
}
const _lockFailures = new Map<string, LockFailureRecord>();

function recordLockFailure(lockName: string): void {
  const now = Date.now();
  let rec = _lockFailures.get(lockName);
  if (!rec || now - rec.windowStart > LOCK_ALARM_WINDOW_MS) {
    if (!rec) evictIfFull(_lockFailures);
    rec = { count: 0, windowStart: now, alarmed: false };
    _lockFailures.set(lockName, rec);
  }
  rec.count++;
  if (rec.count >= LOCK_ALARM_THRESHOLD && !rec.alarmed) {
    rec.alarmed = true;
    process.stderr.write(
      JSON.stringify({
        event: "audit_lock_alarm",
        severity: "CRITICAL",
        lockName,
        consecutiveFailures: rec.count,
        windowMs: LOCK_ALARM_WINDOW_MS,
        pid: process.pid,
        message:
          "Lock acquisition failures exceed threshold — audit pipeline may be blinded.",
      }) + "\n",
    );
  }
}

// ── SEC-039: stale-lock reclaim counter per path ──────────────────────
// If the same lock path is stale-reclaimed N+ times within a window,
// emit a structured alarm (attacker may be re-planting the lock file).
const STALE_RECLAIM_ALARM_THRESHOLD = 3;
const STALE_RECLAIM_WINDOW_MS = 60_000;

interface StaleLockRecord {
  count: number;
  windowStart: number;
  alarmed: boolean;
}
const _staleReclaimCounts = new Map<string, StaleLockRecord>();

function recordStaleReclaim(lockName: string): void {
  const now = Date.now();
  let rec = _staleReclaimCounts.get(lockName);
  if (!rec || now - rec.windowStart > STALE_RECLAIM_WINDOW_MS) {
    if (!rec) evictIfFull(_staleReclaimCounts);
    rec = { count: 0, windowStart: now, alarmed: false };
    _staleReclaimCounts.set(lockName, rec);
  }
  rec.count++;
  if (rec.count >= STALE_RECLAIM_ALARM_THRESHOLD && !rec.alarmed) {
    rec.alarmed = true;
    process.stderr.write(
      JSON.stringify({
        event: "stale_lock_alarm",
        severity: "WARN",
        lockName,
        reclaimCount: rec.count,
        windowMs: STALE_RECLAIM_WINDOW_MS,
        pid: process.pid,
        message:
          "Repeated stale-lock reclamation on the same path — possible DoS via lock re-planting.",
      }) + "\n",
    );
  }
}

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
  // SEC-046: validate the FULL path shape before splitting basename so that
  // error messages (and future log sites) never include a `..`-containing
  // basename from an attacker-controlled `name` argument.
  if (name.includes("..")) {
    throw new Error(
      `FileAdvisoryLock: lock name must not contain '..' path-traversal segments; got '${name}'`,
    );
  }
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
      // SEC-039: track repeated stale-lock reclamations on the same path.
      // If an attacker re-plants the lock file rapidly, this counter fires a
      // structured alarm rather than silently looping.
      recordStaleReclaim(name);
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
      // SEC-022: record this lock-acquisition failure for circuit-breaker
      // tracking. After LOCK_ALARM_THRESHOLD consecutive failures within the
      // window, a structured alarm is emitted to stderr so operators and log
      // aggregators can detect audit-lock saturation attacks.
      recordLockFailure(name);
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
