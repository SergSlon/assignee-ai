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
