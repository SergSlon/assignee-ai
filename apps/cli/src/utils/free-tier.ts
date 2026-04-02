/**
 * Free Tier awareness utility for the preflight cost display.
 * Detects whether a resource type qualifies for AWS Free Tier and surfaces
 * an informational note in the plan box output.
 *
 * Non-blocking by design (AC #6): this module never throws.
 * If detection fails, callers receive `null` and continue without a note.
 *
 * @see Story 7.8 — FR-17 Free Tier Awareness
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { RESOURCE_TYPES } from "@assignee/core";

// ── Types ────────────────────────────────────────────────────────────────────

/** Describes a free tier eligibility note for a given resource type. */
export interface FreeTierNote {
  type: "always_free" | "legacy_eligible" | "credits_apply";
  message: string;
}

// ── Resource maps ────────────────────────────────────────────────────────────

/** Standard free tier message used for resources with no usage limits. */
export const FREE_TIER_MESSAGE = "Always free tier";

/** Resources that are always free regardless of account age. */
const ALWAYS_FREE_RESOURCES: Record<string, string> = {
  [RESOURCE_TYPES.IAM_ROLE]: FREE_TIER_MESSAGE,
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
    const configPath = join(homedir(), ".assignee", "config.yaml");
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
 * Pure function (aside from the optional `accountCreatedDate` parameter).
 *
 * @param resourceType - AWS CloudFormation resource type string
 * @param accountCreatedDate - ISO date string from config, or undefined
 * @returns FreeTierNote or null
 */
export function getFreeTierNote(
  resourceType: string,
  accountCreatedDate?: string,
): FreeTierNote | null {
  // 1. Always-free resources
  const alwaysFreeMsg = ALWAYS_FREE_RESOURCES[resourceType];
  if (alwaysFreeMsg) {
    return { type: "always_free", message: alwaysFreeMsg };
  }

  // 2. Always-free with usage limits
  const alwaysFreeLimitMsg = ALWAYS_FREE_WITH_LIMITS[resourceType];
  if (alwaysFreeLimitMsg) {
    return { type: "always_free", message: alwaysFreeLimitMsg };
  }

  // 3. Legacy 12-month eligible resources
  const legacyMsg = LEGACY_ELIGIBLE_RESOURCES[resourceType];
  if (legacyMsg) {
    if (accountCreatedDate === undefined) {
      return {
        type: "credits_apply",
        message:
          "Free tier eligibility unknown -- check your AWS billing dashboard",
      };
    }

    if (accountCreatedDate >= FREE_TIER_CUTOFF_DATE) {
      return {
        type: "credits_apply",
        message: "AWS credits may apply -- check your billing dashboard",
      };
    }

    // Legacy account: check if still within the 12-month window
    if (isWithin12Months(accountCreatedDate)) {
      return {
        type: "legacy_eligible",
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
