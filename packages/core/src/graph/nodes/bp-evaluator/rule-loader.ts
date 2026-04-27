/**
 * BP rule loader with freshness warning.
 *
 * Story 50-3: the strict-mode/GPG integrity enforcement layer was removed
 * (supply-chain theatre — bumping a signing key is an out-of-band concern).
 * What remains is the same SHA-256 manifest computation used by the release
 * tooling, plus a freshness warning when the BP library mtime is older than
 * 180 days. Rule loading itself is cached after the first call; no
 * integrity gate stands between the caller and loadBestPractices().
 *
 * Wave-6c F3: extracted from bp-evaluator.ts (SRP).
 *
 * MASTER-008 (RW4a): replaced module-level singletons
 * (`cachedPractices`, `freshnessChecked`) with a {@link TenantScopedCache}
 * keyed on (accountId, region, roleArn?). In a multi-tenant SaaS worker,
 * the previous code returned tenant A's BP rules to tenant B for the
 * lifetime of the process. Tenant A and tenant B may legitimately ship
 * different vendored BP libraries (different versions of @assignee/best-
 * practices loaded out of separate worker shards), so cross-tenant
 * leakage isn't merely a freshness-warning bug — it's a wrong-rules
 * bug. The freshness check is also tenant-scoped so each tenant gets
 * one warning emission per process (not zero or one across all tenants).
 */

import {
  loadBestPractices,
  computeFreshness,
  type BestPractice,
} from "@assignee/best-practices";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import {
  type TenantId,
  createLegacySingleTenantId,
} from "@/tenant/tenant-id.js";
import { TenantScopedCache } from "@/tenant/tenant-scoped-cache.js";

/** Per-tenant cache of loaded BP practices. */
const practicesCache = new TenantScopedCache<BestPractice[]>();

/** Per-tenant flag: did we already emit the freshness-stale warning? */
const freshnessCheckedCache = new TenantScopedCache<true>();

/**
 * Loads BP rules, caches per tenant after the first load.
 *
 * `tenantId` is optional during the migration: when omitted, the loader
 * falls back to {@link createLegacySingleTenantId} which derives identity
 * from `AWS_ACCOUNT_ID` / `AWS_REGION` env vars. Single-tenant CLI mode
 * is safe; multi-tenant SaaS callers MUST pass an explicit `tenantId`.
 *
 * TODO(SaaS): drop the legacy fallback and make `tenantId` required
 * once `orchestrator.ts` (the only production caller) threads it
 * through from graph state.
 */
export function loadCached(tenantId?: TenantId): BestPractice[] {
  const tid = tenantId ?? createLegacySingleTenantId();
  const cached = practicesCache.get(tid);
  if (cached !== undefined) {
    return cached;
  }

  const loaded = loadBestPractices();

  // Emit a single stderr warning per tenant if the library is stale; never blocks.
  if (!freshnessCheckedCache.has(tid)) {
    freshnessCheckedCache.set(tid, true);
    try {
      const freshness = computeFreshness();
      if (freshness.isStale) {
        process.stderr.write(
          `⚠  Best-practice rules are stale (oldest file is ${freshness.oldestAgeDays} days old, threshold is ${freshness.staleThresholdDays}). ` +
            `Consider updating assignee-ai.\n`,
        );
      }
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
        extras: { phase: "freshness_check", error: String(err) },
      });
    }
  }

  practicesCache.set(tid, loaded);
  return loaded;
}

/**
 * Resets the cached practices. Intended for testing only.
 *
 * Tenant-scoped: pass a `tenantId` to evict only that tenant's cache.
 * No argument → wipe every tenant. The tests in
 * `bp-evaluator.test.ts`, `bp-enforcement-integration.test.ts`, and
 * `apply-mode-audit.test.ts` call this with no argument between
 * cases, which still works (clears every cached tenant).
 */
export function resetBPCache(tenantId?: TenantId): void {
  if (tenantId) {
    practicesCache.clear(tenantId);
    freshnessCheckedCache.clear(tenantId);
  } else {
    practicesCache.clear();
    freshnessCheckedCache.clear();
  }
}
