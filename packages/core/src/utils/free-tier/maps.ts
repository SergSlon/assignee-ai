/**
 * Free Tier data maps — pure, synchronous, no IO.
 *
 * This module owns the raw category → resource maps plus the
 * {@link FreeTierMaps} accessor. Extracted from the parent
 * `utils/free-tier.ts` in Story 60-it1-01 (closes `it59-1-L7-001` MED)
 * so the parent file holds only the classifier + IO wrapper. MCP
 * (or any other consumer) can reshape these into their own note
 * format without redefining the underlying data.
 *
 * All exports are re-exported through `../free-tier.ts` to preserve
 * the public API — consumers should continue to import from
 * `@assignee/core` (the barrel) or `./free-tier.js` / `../free-tier.js`
 * (intra-package). Do not import from this sub-module directly.
 *
 * @see Story 58-it1-01 — pure/IO split for MCP shape-adapter reuse (L4-004)
 * @see Story 60-it1-01 — data-layer extraction (L7-001)
 */

import {
  RESOURCE_TYPES,
  LIST_RESOURCE_TYPES,
} from "../../config/resource-types/index.js";
import { FREE_TIER_MESSAGE } from "../../pricing/filter-constants.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Named constants for free tier eligibility categories. */
export const FreeTierType = {
  ALWAYS_FREE: "always_free",
  LEGACY_ELIGIBLE: "legacy_eligible",
  CREDITS_APPLY: "credits_apply",
} as const;
export type FreeTierTypeValue =
  (typeof FreeTierType)[keyof typeof FreeTierType];

/** Describes a free tier eligibility note for a given resource type. */
export interface FreeTierNote {
  type: FreeTierTypeValue;
  message: string;
}

/**
 * Pure data shape returned by {@link getFreeTierMaps}. Consumers (including
 * the MCP shape-adapter in `apps/mcp-server/src/services/free-tier.ts`)
 * should treat these as read-only.
 */
export interface FreeTierMaps {
  /** Resources that are always free regardless of account age. */
  readonly alwaysFree: Readonly<Record<string, string>>;
  /** Resources that are always free but with per-month usage limits. */
  readonly alwaysFreeWithLimits: Readonly<Record<string, string>>;
  /**
   * Resources eligible for the legacy 12-month free tier (accounts created
   * before `cutoffDate`). Post-cutoff accounts receive AWS credits instead.
   */
  readonly legacyEligible: Readonly<Record<string, string>>;
  /** ISO date string for the legacy-free-tier → credits cutover. */
  readonly cutoffDate: string;
}

// ── Resource maps (private, raw data) ────────────────────────────────────────

// Re-export FREE_TIER_MESSAGE for backward-compat callers
export { FREE_TIER_MESSAGE };

/** Resources that are always free regardless of account age. */
const ALWAYS_FREE_RESOURCES: Record<string, string> = {
  [RESOURCE_TYPES.IAM_ROLE]: FREE_TIER_MESSAGE,
  [LIST_RESOURCE_TYPES.IAM_MANAGED_POLICY]: FREE_TIER_MESSAGE,
  [RESOURCE_TYPES.SSM_PARAMETER]: `${FREE_TIER_MESSAGE} (standard params, up to 10K)`,
  [RESOURCE_TYPES.EC2_VPC]: FREE_TIER_MESSAGE,
  [RESOURCE_TYPES.EC2_SUBNET]: FREE_TIER_MESSAGE,
  [RESOURCE_TYPES.EC2_SECURITY_GROUP]: FREE_TIER_MESSAGE,
  [RESOURCE_TYPES.EC2_INTERNET_GATEWAY]: FREE_TIER_MESSAGE,
  [RESOURCE_TYPES.EC2_ROUTE_TABLE]: FREE_TIER_MESSAGE,
  [RESOURCE_TYPES.EC2_ROUTE]: FREE_TIER_MESSAGE,
  [RESOURCE_TYPES.ECS_CLUSTER]: `${FREE_TIER_MESSAGE} (compute charged separately via tasks)`,
};

/** Resources that are always free but with usage limits. */
const ALWAYS_FREE_WITH_LIMITS: Record<string, string> = {
  [RESOURCE_TYPES.DYNAMODB_TABLE]: "Up to 25 GB storage, 25 WCU/RCU",
  [RESOURCE_TYPES.LAMBDA_FUNCTION]:
    "1M requests/month + 400K GB-seconds compute",
  [RESOURCE_TYPES.SQS_QUEUE]: "1M requests/month",
  [RESOURCE_TYPES.SNS_TOPIC]: "1M publishes/month",
};

/**
 * Resources eligible for the legacy 12-month free tier (accounts created
 * before July 15, 2025). Post-July-2025 accounts receive credits instead.
 */
const LEGACY_ELIGIBLE_RESOURCES: Record<string, string> = {
  [RESOURCE_TYPES.EC2_INSTANCE]: "750 hrs/month t2.micro/t3.micro",
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: "750 hrs/month db.t2.micro/db.t3.micro",
};

/** The date when AWS changed from 12-month free tier to credits model. */
const FREE_TIER_CUTOFF_DATE = "2025-07-15";

/**
 * Pre-built frozen snapshot of the maps. Built once at module load so
 * {@link getFreeTierMaps} returns a stable reference (cheap to call in hot
 * paths such as the preflight guard loop) and so consumers cannot mutate
 * the shared data.
 */
const FREE_TIER_MAPS_SNAPSHOT: FreeTierMaps = Object.freeze({
  alwaysFree: Object.freeze({ ...ALWAYS_FREE_RESOURCES }),
  alwaysFreeWithLimits: Object.freeze({ ...ALWAYS_FREE_WITH_LIMITS }),
  legacyEligible: Object.freeze({ ...LEGACY_ELIGIBLE_RESOURCES }),
  cutoffDate: FREE_TIER_CUTOFF_DATE,
});

/**
 * Pure, synchronous accessor for the free-tier resource maps.
 *
 * No IO: does not read files, does not call `Date.now()`, does not touch
 * the YAML config. Always returns the same frozen snapshot so callers
 * can safely cache the reference.
 *
 * Used by:
 * - The classifier `getFreeTierNote` in the parent `../free-tier.ts`.
 * - The MCP shape-adapter in `apps/mcp-server/src/services/free-tier.ts`
 *   which reshapes these maps into MCP's own `FreeTierInfo` shape without
 *   redefining the underlying data (L4-004 dedup).
 */
export function getFreeTierMaps(): FreeTierMaps {
  return FREE_TIER_MAPS_SNAPSHOT;
}
