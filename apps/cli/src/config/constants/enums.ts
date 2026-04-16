/**
 * Named-constant enums for magic strings (Promise statuses, cleanup
 * category names, pricing cache categories, log sources, wizard
 * sentinel values, fallback placeholders). Domain sub-module of the
 * former `config/constants.ts` coupling hub (Story 49.5).
 */

import { CACHE_DIR_NAME } from "@assignee/core";

/** Cleanup category identifiers — single source of truth. */
export const CleanupCategoryName = {
  CHECKPOINTS: "checkpoints" as const,
  CACHE: CACHE_DIR_NAME,
  MEMORY: "memory" as const,
} as const;

/** Pricing category identifiers for cache TTL lookup. */
export const PricingCategory = {
  COMPUTE: "compute" as const,
  STORAGE: "storage" as const,
  DEFAULT: "default" as const,
} as const;

/** Log source identifiers for structured logging extras. */
export const LogSource = {
  CACHE: "cache" as const,
  NETWORK: "network" as const,
  LOCAL: "local" as const,
} as const;

/** Named constants for Promise.allSettled status values. */
export const PromiseStatus = {
  FULFILLED: "fulfilled",
  REJECTED: "rejected",
} as const;

/** Sentinel value for "none of these" in AMI selection wizard. */
export const WIZARD_NONE_SENTINEL = "__none__" as const;

/** Generic "unknown" fallback for missing metadata fields (ARN parts, etc.). */
export const UNKNOWN_FALLBACK = "unknown" as const;
