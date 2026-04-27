/**
 * TenantScopedCache — Map keyed on canonicalized {@link TenantId}.
 *
 * Replaces the module-level `let cachedX: T | undefined` pattern
 * which leaks the first tenant's data into every subsequent tenant
 * for the lifetime of the process.
 *
 * # Usage
 *
 * ```ts
 * const accountIdCache = new TenantScopedCache<string>();
 *
 * async function getAccountId(tenantId: TenantId): Promise<string> {
 *   const cached = accountIdCache.get(tenantId);
 *   if (cached !== undefined) return cached;
 *   const fresh = await sts.send(new GetCallerIdentityCommand({}));
 *   const value = fresh.Account!;
 *   accountIdCache.set(tenantId, value);
 *   return value;
 * }
 * ```
 *
 * # Eviction
 *
 * `clear(tenantId)` evicts a single tenant — call on sign-out or
 * STS-token refresh. `clear()` (no arg) wipes everything; intended
 * for tests that need a clean slate between cases.
 *
 * # Concurrency
 *
 * The underlying `Map` operations are synchronous. Callers that need
 * single-flight coalescing of an in-flight async lookup should layer
 * an `inFlight` Map<string, Promise<T>> on top of this cache (see
 * {@link resolveResourceArn} for the pattern).
 */

import type { TenantId } from "./tenant-id.js";
import { tenantIdToKey } from "./tenant-id.js";

export class TenantScopedCache<T> {
  private readonly store = new Map<string, T>();

  /**
   * Returns the cached value for `tenantId`, or `undefined` if there
   * is no entry. Uses `has`/`get` semantics — a tenant that has
   * `undefined` set explicitly will still report as a hit via
   * {@link has}.
   */
  get(tenantId: TenantId): T | undefined {
    return this.store.get(tenantIdToKey(tenantId));
  }

  /**
   * Sets the cached value for `tenantId`. Overwrites any prior entry.
   */
  set(tenantId: TenantId, value: T): void {
    this.store.set(tenantIdToKey(tenantId), value);
  }

  /**
   * Whether the cache has an entry for `tenantId`. Distinguishes
   * "explicitly set to undefined" from "never set".
   */
  has(tenantId: TenantId): boolean {
    return this.store.has(tenantIdToKey(tenantId));
  }

  /**
   * Evicts the entry for `tenantId` if present. With no argument,
   * evicts every entry — use sparingly (intended for tests).
   */
  clear(tenantId?: TenantId): void {
    if (tenantId) {
      this.store.delete(tenantIdToKey(tenantId));
    } else {
      this.store.clear();
    }
  }

  /**
   * Number of distinct tenants currently cached. Intended for
   * observability and tests; not for cache-eviction policy.
   */
  size(): number {
    return this.store.size;
  }
}
