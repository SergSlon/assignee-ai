/**
 * Free tier awareness for the MCP server's estimate_cost tool.
 * Simplified version of apps/cli/src/utils/free-tier.ts — no config file reading,
 * just the static resource type -> free tier mapping.
 *
 * @see Story 7.8, Story 20.4
 */

import { RESOURCE_TYPES, FREE_TIER_MESSAGE } from "@assignee/core";

/** Free tier info returned by getFreeTierNote. */
export interface FreeTierInfo {
  type: "always_free" | "usage_limited" | "legacy_eligible";
  message: string;
}

/** Resources that are always free regardless of account age. */
const ALWAYS_FREE: Record<string, string> = {
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
  [RESOURCE_TYPES.DYNAMODB_TABLE]: `${FREE_TIER_MESSAGE} (up to 25 GB storage, 25 WCU/RCU)`,
  [RESOURCE_TYPES.LAMBDA_FUNCTION]:
    "AWS Lambda Free Tier: 1M requests/month + 400,000 GB-s compute",
  [RESOURCE_TYPES.SQS_QUEUE]: "AWS SQS Free Tier: 1M requests/month",
  [RESOURCE_TYPES.SNS_TOPIC]: "AWS SNS Free Tier: 1M publishes/month",
};

/** Resources that may be eligible for legacy 12-month free tier or AWS credits. */
const LEGACY_ELIGIBLE: Record<string, string> = {
  [RESOURCE_TYPES.EC2_INSTANCE]:
    "May be free tier eligible (750 hrs/month t2.micro/t3.micro — depends on account age)",
  [RESOURCE_TYPES.RDS_DB_INSTANCE]:
    "May be free tier eligible (750 hrs/month db.t2.micro/db.t3.micro — depends on account age)",
};

/**
 * Returns free tier information for a resource type, or null if not applicable.
 */
export function getFreeTierNote(resourceType: string): FreeTierInfo | null {
  const alwaysFree = ALWAYS_FREE[resourceType];
  if (alwaysFree) {
    return { type: "always_free", message: alwaysFree };
  }

  const usageLimited = ALWAYS_FREE_WITH_LIMITS[resourceType];
  if (usageLimited) {
    return { type: "usage_limited", message: usageLimited };
  }

  const legacyEligible = LEGACY_ELIGIBLE[resourceType];
  if (legacyEligible) {
    return { type: "legacy_eligible", message: legacyEligible };
  }

  return null;
}
