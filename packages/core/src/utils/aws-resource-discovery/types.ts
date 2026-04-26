/**
 * Shared types for the AWS resource-discovery subsystem.
 */

/** Option shape compatible with ResourceField question options. */
export interface DiscoveryOption {
  value: string;
  label: string;
}

/** Cache entry with TTL support. */
export interface CacheEntry {
  data: DiscoveryOption[];
  fetchedAt: number;
  ttl: number;
}

/** Categorized instance type for the two-step category select. */
export interface InstanceTypeCategory {
  key: string;
  label: string;
  description: string;
  options: DiscoveryOption[];
}

export const DISCOVERY_TIMEOUT_MS = 6000;

/**
 * Negative-cache TTL for KMS key discovery (MED-2).
 * When a KMS ListKeys call returns 0 keys (e.g. fresh account, or all keys
 * are AWS-managed), cache the empty result for 30 seconds to prevent
 * repeated API calls within the same wizard flow.
 */
export const KMS_NEGATIVE_CACHE_TTL_MS = 30_000;
