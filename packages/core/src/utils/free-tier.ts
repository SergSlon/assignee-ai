/**
 * Free Tier awareness utility for the preflight cost display.
 * Detects whether a resource type qualifies for AWS Free Tier and surfaces
 * an informational note in the plan box output.
 *
 * Non-blocking by design (AC #6): this module never throws.
 * If detection fails, callers receive `null` and continue without a note.
 *
 * @see Story 7.8 — FR-17 Free Tier Awareness
 * @see Story 58-it1-01 — pure/IO split for MCP shape-adapter reuse (L4-004)
 *
 * ## Architecture
 *
 * - {@link getFreeTierMaps} — pure, synchronous accessor for the raw
 *   category → resource maps. No IO, no file reads, no date parsing.
 *   MCP (or any other consumer) can reshape these into their own note
 *   format without redefining the underlying data.
 * - {@link getFreeTierNote} — pure classifier that consults the maps and
 *   the optional account-created date to produce a core `FreeTierNote`.
 * - {@link getFreeTierNoteWithConfig} — IO entry that reads the YAML
 *   config for `aws_account_created` then delegates to `getFreeTierNote`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ASSIGNEE_DIR } from "../config/cfn-keys.js";
import { FileName } from "../config/constants/paths.js";
import {
  RESOURCE_TYPES,
  LIST_RESOURCE_TYPES,
} from "../config/resource-types/index.js";
import {
  FREE_TIER_MESSAGE,
  CostEstimateLabel,
} from "../pricing/filter-constants.js";

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
 * - The classifier {@link getFreeTierNote} inside this file.
 * - The MCP shape-adapter in `apps/mcp-server/src/services/free-tier.ts`
 *   which reshapes these maps into MCP's own `FreeTierInfo` shape without
 *   redefining the underlying data (L4-004 dedup).
 */
export function getFreeTierMaps(): FreeTierMaps {
  return FREE_TIER_MAPS_SNAPSHOT;
}

// ── Account date detection (Task 2) ──────────────────────────────────────────

/** Module-level cache to avoid re-reading config on every call. */
let cachedAccountDate: string | undefined | null = null; // null = not yet loaded

/**
 * Reads the AWS account creation date from `~/.assignee/config.yaml`.
 * Returns the `aws_account_created` field value (ISO date string) or
 * `undefined` if the file is missing, the field is absent, or parsing fails.
 *
 * NEVER throws — this is non-blocking (AC #6).
 */
export function loadAccountCreatedDate(): string | undefined {
  if (cachedAccountDate !== null) {
    return cachedAccountDate;
  }

  try {
    const configPath = join(homedir(), ASSIGNEE_DIR, FileName.CONFIG);
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown> | undefined;
    const dateValue = parsed?.["aws_account_created"];

    cachedAccountDate = typeof dateValue === "string" ? dateValue : undefined;
  } catch {
    cachedAccountDate = undefined;
  }

  return cachedAccountDate;
}

/**
 * Resets the cached account date. Exposed for testing only.
 * @internal
 */
export function _resetAccountDateCache(): void {
  cachedAccountDate = null;
}

// ── Core detection function ──────────────────────────────────────────────────

/**
 * Returns a free tier eligibility note for the given resource type, or `null`
 * if the resource is not covered by any known free tier category.
 *
 * Pure function (aside from the optional `accountCreatedDate` parameter and
 * `Date.now()` used for the 12-month window check).
 *
 * @param resourceType - AWS CloudFormation resource type string
 * @param accountCreatedDate - ISO date string from config, or undefined
 * @returns FreeTierNote or null
 */
export function getFreeTierNote(
  resourceType: string,
  accountCreatedDate?: string,
): FreeTierNote | null {
  const { alwaysFree, alwaysFreeWithLimits, legacyEligible, cutoffDate } =
    getFreeTierMaps();

  // 1. Always-free resources
  const alwaysFreeMsg = alwaysFree[resourceType];
  if (alwaysFreeMsg) {
    return { type: FreeTierType.ALWAYS_FREE, message: alwaysFreeMsg };
  }

  // 2. Always-free with usage limits
  const alwaysFreeLimitMsg = alwaysFreeWithLimits[resourceType];
  if (alwaysFreeLimitMsg) {
    return { type: FreeTierType.ALWAYS_FREE, message: alwaysFreeLimitMsg };
  }

  // 3. Legacy 12-month eligible resources
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

    // Legacy account: check if still within the 12-month window
    if (isWithin12Months(accountCreatedDate)) {
      return {
        type: FreeTierType.LEGACY_ELIGIBLE,
        message: `Free tier: ${legacyMsg} remaining`,
      };
    }

    // Legacy account but 12-month window expired
    return null;
  }

  // 4. Not in any map
  return null;
}

/**
 * IO entry point: reads the YAML config (cached) for `aws_account_created`
 * and delegates to the pure {@link getFreeTierNote} classifier.
 *
 * Prefer this function when calling from code paths that already accept IO
 * side effects (preflight guard, CLI output). The IO is split out from the
 * classifier so test suites and the MCP adapter can use the pure APIs
 * without mocking `node:fs`.
 *
 * NEVER throws — `loadAccountCreatedDate` swallows errors and returns
 * `undefined`, which `getFreeTierNote` handles as "eligibility unknown".
 *
 * @param resourceType - AWS CloudFormation resource type string
 * @returns FreeTierNote or null
 */
export function getFreeTierNoteWithConfig(
  resourceType: string,
): FreeTierNote | null {
  return getFreeTierNote(resourceType, loadAccountCreatedDate());
}

/**
 * Checks whether the account creation date is within 12 months from today.
 * Uses simple date string comparison — no timezone conversion needed for
 * day-level granularity.
 */
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
 * Used by the list command as a fallback when the provision log has no cost entry.
 */
export function getFreeTierCostLabel(resourceType: string): string | null {
  if (getFreeTierMaps().alwaysFree[resourceType]) {
    return CostEstimateLabel.FREE;
  }
  return null;
}
