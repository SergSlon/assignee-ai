/**
 * Free Tier awareness utility for the preflight cost display.
 * Detects whether a resource type qualifies for AWS Free Tier and surfaces
 * an informational note in the plan box output.
 *
 * Non-blocking by design (AC #6): this module never throws. If detection
 * fails, callers receive `null` and continue without a note.
 *
 * Architecture:
 * - Data maps live in `./free-tier/maps.ts` (Story 60-it1-01, L7-001).
 * - {@link getFreeTierNote} — pure classifier over those maps.
 * - {@link getFreeTierNoteWithConfig} — IO entry that reads the YAML
 *   config for `aws_account_created` then delegates to the classifier.
 *
 * @see Story 7.8 — FR-17 Free Tier Awareness
 * @see Story 58-it1-01 — pure/IO split (L4-004)
 * @see Story 60-it1-01 — data-layer extraction (L7-001)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ASSIGNEE_DIR } from "../config/cfn-keys.js";
import { FileName } from "../config/constants/paths.js";
import { CostEstimateLabel } from "../pricing/filter-constants.js";
import {
  FreeTierType,
  getFreeTierMaps,
  type FreeTierNote,
} from "./free-tier/maps.js";
import {
  type TenantId,
  createLegacySingleTenantId,
} from "../tenant/tenant-id.js";
import { TenantScopedCache } from "../tenant/tenant-scoped-cache.js";

// Preserve public API: re-export data-layer symbols so existing consumers
// (`import { … } from "./free-tier.js"`) keep resolving post-extraction.
export {
  FreeTierType,
  FREE_TIER_MESSAGE,
  getFreeTierMaps,
  type FreeTierTypeValue,
  type FreeTierNote,
  type FreeTierMaps,
} from "./free-tier/maps.js";

/**
 * MASTER-008 (RW4a): per-tenant cache of the `aws_account_created`
 * date read from `~/.assignee/config.yaml`.
 *
 * Two sentinel meanings:
 *   - cache miss (no entry) → "not yet loaded"; the next read attempts
 *     the file system.
 *   - cache hit with `undefined` → "loaded but file/key absent or
 *     unreadable"; subsequent reads short-circuit without re-touching
 *     the disk.
 *
 * Distinguishing these via {@link TenantScopedCache.has} replaces the
 * previous `null | undefined | string` triple-state on a module-local
 * `let`. The previous code returned tenant A's account-creation date
 * to tenant B for the lifetime of the process — wrong free-tier
 * eligibility decisions for every subsequent tenant.
 */
const accountDateCache = new TenantScopedCache<string | undefined>();

/**
 * Reads `aws_account_created` from `~/.assignee/config.yaml` (cached
 * per tenant). NEVER throws — returns `undefined` on any error.
 *
 * `tenantId` is optional during the migration: when omitted, falls back
 * to {@link createLegacySingleTenantId} which reads
 * `AWS_ACCOUNT_ID`/`AWS_REGION` from env. Single-tenant CLI mode is
 * safe; multi-tenant SaaS callers MUST pass an explicit `tenantId`.
 *
 * TODO(SaaS): replace the legacy fallback once
 * `preflight-guard/free-tier.ts` (the one production caller) threads
 * tenantId through from graph state.
 */
export function loadAccountCreatedDate(
  tenantId?: TenantId,
): string | undefined {
  const tid = tenantId ?? createLegacySingleTenantId();
  if (accountDateCache.has(tid)) return accountDateCache.get(tid);
  let result: string | undefined;
  try {
    const configPath = join(homedir(), ASSIGNEE_DIR, FileName.CONFIG);
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown> | undefined;
    const dateValue = parsed?.["aws_account_created"];
    result = typeof dateValue === "string" ? dateValue : undefined;
  } catch {
    result = undefined;
  }
  accountDateCache.set(tid, result);
  return result;
}

/**
 * @internal Resets the cached account date. Testing only.
 *
 * Tenant-scoped: pass `tenantId` to evict only that tenant's cache.
 * No argument → wipe every tenant. The `free-tier.test.ts` and the
 * pricing-decomposer tests call this with no argument between cases,
 * which still works (clears every cached tenant).
 */
export function _resetAccountDateCache(tenantId?: TenantId): void {
  if (tenantId) accountDateCache.clear(tenantId);
  else accountDateCache.clear();
}

/**
 * Returns a free tier eligibility note for the given resource type, or
 * `null` if the resource is not covered by any known category.
 */
export function getFreeTierNote(
  resourceType: string,
  accountCreatedDate?: string,
): FreeTierNote | null {
  const { alwaysFree, alwaysFreeWithLimits, legacyEligible, cutoffDate } =
    getFreeTierMaps();

  const alwaysFreeMsg = alwaysFree[resourceType];
  if (alwaysFreeMsg) {
    return { type: FreeTierType.ALWAYS_FREE, message: alwaysFreeMsg };
  }

  const alwaysFreeLimitMsg = alwaysFreeWithLimits[resourceType];
  if (alwaysFreeLimitMsg) {
    return { type: FreeTierType.ALWAYS_FREE, message: alwaysFreeLimitMsg };
  }

  const legacyMsg = legacyEligible[resourceType];
  if (legacyMsg) {
    if (accountCreatedDate === undefined) {
      return {
        type: FreeTierType.CREDITS_APPLY,
        message:
          "Free tier eligibility unknown -- check your AWS billing dashboard",
      };
    }
    if (accountCreatedDate >= cutoffDate) {
      return {
        type: FreeTierType.CREDITS_APPLY,
        message: "AWS credits may apply -- check your billing dashboard",
      };
    }
    if (isWithin12Months(accountCreatedDate)) {
      return {
        type: FreeTierType.LEGACY_ELIGIBLE,
        message: `Free tier: ${legacyMsg} remaining`,
      };
    }
    return null; // Legacy account but 12-month window expired.
  }

  return null;
}

/**
 * IO entry: reads the YAML config (cached per tenant) then delegates
 * to the pure {@link getFreeTierNote} classifier. NEVER throws.
 *
 * `tenantId` is optional during the migration; see
 * {@link loadAccountCreatedDate} for the fallback semantics and the
 * SaaS-mode TODO.
 */
export function getFreeTierNoteWithConfig(
  resourceType: string,
  tenantId?: TenantId,
): FreeTierNote | null {
  return getFreeTierNote(resourceType, loadAccountCreatedDate(tenantId));
}

/** Whether `dateStr` is within 12 months from today. Day-level granularity. */
function isWithin12Months(dateStr: string): boolean {
  const created = new Date(dateStr);
  if (isNaN(created.getTime())) return false;
  const now = new Date();
  const twelveMonthsAgo = new Date(
    now.getFullYear() - 1,
    now.getMonth(),
    now.getDate(),
  );
  return created >= twelveMonthsAgo;
}

/**
 * Returns "Free" for always-free resource types, or null if cost is unknown.
 * Used by the list command as a fallback when the provision log has no cost.
 */
export function getFreeTierCostLabel(resourceType: string): string | null {
  if (getFreeTierMaps().alwaysFree[resourceType]) {
    return CostEstimateLabel.FREE;
  }
  return null;
}
