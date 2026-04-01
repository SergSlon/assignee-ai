/**
 * Free tier awareness for the MCP server's estimate_cost tool.
 * Simplified version of apps/cli/src/utils/free-tier.ts — no config file reading,
 * just the static resource type -> free tier mapping.
 *
 * @see Story 7.8, Story 20.4
 */

/** Free tier info returned by getFreeTierNote. */
export interface FreeTierInfo {
  type: "always_free" | "usage_limited" | "legacy_eligible";
  message: string;
}

/** Resources that are always free regardless of account age. */
const ALWAYS_FREE: Record<string, string> = {
  "AWS::IAM::Role": "Always free tier",
  "AWS::SSM::Parameter": "Always free tier (standard params, up to 10K)",
  "AWS::EC2::VPC": "Always free tier",
  "AWS::EC2::Subnet": "Always free tier",
  "AWS::EC2::SecurityGroup": "Always free tier",
  "AWS::EC2::InternetGateway": "Always free tier",
  "AWS::EC2::RouteTable": "Always free tier",
  "AWS::EC2::Route": "Always free tier",
  "AWS::ECS::Cluster":
    "Always free tier (compute charged separately via tasks)",
};

/** Resources that are always free but with usage limits. */
const ALWAYS_FREE_WITH_LIMITS: Record<string, string> = {
  "AWS::DynamoDB::Table": "Always free tier (up to 25 GB storage, 25 WCU/RCU)",
  "AWS::Lambda::Function":
    "AWS Lambda Free Tier: 1M requests/month + 400,000 GB-s compute",
  "AWS::SQS::Queue": "AWS SQS Free Tier: 1M requests/month",
  "AWS::SNS::Topic": "AWS SNS Free Tier: 1M publishes/month",
};

/** Resources that may be eligible for legacy 12-month free tier or AWS credits. */
const LEGACY_ELIGIBLE: Record<string, string> = {
  "AWS::EC2::Instance":
    "May be free tier eligible (750 hrs/month t2.micro/t3.micro — depends on account age)",
  "AWS::RDS::DBInstance":
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
