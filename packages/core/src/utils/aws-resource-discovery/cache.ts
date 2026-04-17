/**
 * Per-session discovery cache with per-fetcher TTL overrides.
 *
 * Discovery is a best-effort, read-only feature. Results are cached to
 * avoid redundant API calls across a single CLI invocation. Entries
 * expire after their configured TTL.
 */

import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import type { CacheEntry, DiscoveryOption } from "./types.js";

/** Default TTL: 5 minutes. */
const DEFAULT_TTL_MS = 300_000;

/** Per-fetcher TTL overrides (milliseconds). */
const FETCHER_TTL: Record<string, number> = {
  [DiscoveryCacheKey.AMIS]: 120_000, // 2 min
  [DiscoveryCacheKey.SUBNETS]: 120_000, // 2 min
  [DiscoveryCacheKey.KEY_PAIRS]: 120_000, // 2 min
  [DiscoveryCacheKey.SECURITY_GROUPS]: 120_000, // 2 min
  [DiscoveryCacheKey.RDS_ENGINE_VERSIONS]: 300_000, // 5 min
  [DiscoveryCacheKey.RDS_INSTANCE_CLASSES]: 300_000, // 5 min
  [DiscoveryCacheKey.LAMBDA_RUNTIMES]: 900_000, // 15 min
};

const discoveryCache = new Map<string, CacheEntry>();

/** Reset cache — used by tests and when region changes. */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

export async function cachedDiscover(
  key: string,
  fetcher: () => Promise<DiscoveryOption[]>,
): Promise<DiscoveryOption[]> {
  const entry = discoveryCache.get(key);
  if (entry) {
    const age = Date.now() - entry.fetchedAt;
    if (age < entry.ttl) {
      return entry.data;
    }
    // Expired — remove stale entry
    discoveryCache.delete(key);
  }

  try {
    const results = await fetcher();
    if (results.length > 0) {
      const ttl = FETCHER_TTL[key] ?? DEFAULT_TTL_MS;
      discoveryCache.set(key, { data: results, fetchedAt: Date.now(), ttl });
    }
    return results;
  } catch {
    // Discovery is best-effort — callers fall back to manual entry.
    return [];
  }
}
