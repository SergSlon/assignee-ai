/**
 * W4-03 (Epic 100 Round 3) — AdvisoryLockPort: hexagonal port for
 * advisory filesystem/distributed locking.
 *
 * Substrate for Epic 102's Postgres/DDB distributed lock adapter.
 * Today's adapter: FileAdvisoryLockAdapter (file-based, single-host).
 *
 * Design constraints:
 *   - `acquire`/`release` are low-level operations for callers that need
 *     explicit control (e.g. retry loops).
 *   - `withLock` is the preferred high-level wrapper — automatically releases
 *     on both success and error paths.
 *   - All methods must be safe to call concurrently from the same process.
 *   - Implementation must be idempotent for `release` — releasing an
 *     already-released lock must not throw.
 *
 * @see packages/core/src/locks/file-advisory-lock.ts
 */

// ── AdvisoryLockPort interface ────────────────────────────────────────

/**
 * Hexagonal port for advisory locking. Implementations MUST be:
 *   - Non-throwing for `release` — always safe to call in a finally block.
 *   - Idempotent for `release` — calling twice on the same lock name is a no-op.
 *   - Bounded: stale locks (e.g. from a process that crashed) must be
 *     reclaimed after a reasonable timeout (implementation-defined, typically
 *     10 seconds for file-based adapters).
 */
export interface AdvisoryLockPort {
  /**
   * Attempt to acquire the advisory lock identified by `name`.
   *
   * @param name - Lock identifier (e.g. file path, resource name).
   * @returns `true` if the lock was acquired; `false` if it is held by
   *   another holder. The caller is responsible for retry logic.
   */
  acquire(name: string): Promise<boolean>;

  /**
   * Release the advisory lock identified by `name`.
   * No-op (does not throw) when the lock is not held.
   *
   * @param name - Lock identifier matching a prior `acquire` call.
   */
  release(name: string): Promise<void>;

  /**
   * Acquire the lock, execute `fn`, then release — in a try/finally
   * block so the lock is always released even when `fn` throws.
   *
   * If the lock cannot be acquired, this method retries with exponential
   * backoff (implementation-defined — see FileAdvisoryLockAdapter for
   * concrete parameters). When the retry budget is exhausted, `fn` is
   * called WITHOUT the lock (best-effort fallback — callers must tolerate
   * occasional non-exclusive execution; the lock is advisory, not a hard
   * mutex).
   *
   * @param name - Lock identifier.
   * @param fn   - Callback to execute while the lock is held.
   * @returns The return value of `fn`.
   */
  withLock<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}
