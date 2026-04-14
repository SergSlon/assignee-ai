/**
 * Lightweight cost estimation service for the estimate_cost MCP tool.
 *
 * Uses the PricingStrategyRegistry from @assignee/core for local
 * cost estimation. Does NOT run the full LangGraph pipeline.
 *
 * Resource type classification uses keyword matching (zero-cost, <1ms).
 *
 * @see Story 20.4
 */

import {
  defaultPricingRegistry,
  RESOURCE_TYPES,
  type PricingEstimate,
} from "@assignee/core";
import { getFreeTierNote } from "./free-tier.js";

/** Result shape for the estimate_cost tool. */
export interface CostEstimateResult {
  resourceType: string;
  estimatedMonthlyCost: string;
  freeTierEligible?: boolean;
  freeTierNote?: string;
}

/**
 * Maps natural language keywords to CloudFormation resource types.
 * Used for classifying the resource type from a description string.
 */
const KEYWORD_TO_RESOURCE_TYPE: Array<{
  keywords: string[];
  resourceType: string;
}> = [
  {
    keywords: ["s3", "bucket", "object storage"],
    resourceType: RESOURCE_TYPES.S3_BUCKET,
  },
  {
    keywords: ["lambda", "serverless function", "function as a service"],
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
  },
  {
    keywords: ["dynamodb", "dynamo", "nosql table"],
    resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
  },
  {
    keywords: ["ec2", "virtual machine", "compute instance"],
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
  },
  {
    keywords: ["rds", "relational database", "postgresql", "mysql", "aurora"],
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
  },
  {
    keywords: ["sqs", "message queue", "queue service"],
    resourceType: RESOURCE_TYPES.SQS_QUEUE,
  },
  {
    keywords: ["sns", "notification", "pub/sub", "publish subscribe"],
    resourceType: RESOURCE_TYPES.SNS_TOPIC,
  },
  {
    keywords: ["iam role", "execution role", "service role"],
    resourceType: RESOURCE_TYPES.IAM_ROLE,
  },
  {
    keywords: ["ssm parameter", "parameter store", "systems manager parameter"],
    resourceType: RESOURCE_TYPES.SSM_PARAMETER,
  },
  {
    keywords: ["ecs", "container service", "fargate"],
    resourceType: RESOURCE_TYPES.ECS_CLUSTER,
  },
  {
    keywords: ["secrets manager", "secret", "credentials store"],
    resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
  },
  {
    keywords: ["ecr", "container registry", "docker registry"],
    resourceType: RESOURCE_TYPES.ECR_REPOSITORY,
  },
  {
    keywords: ["vpc", "virtual private cloud"],
    resourceType: RESOURCE_TYPES.EC2_VPC,
  },
  {
    keywords: ["security group", "firewall"],
    resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
  },
  {
    keywords: [
      "load balancer",
      "application load balancer",
      "network load balancer",
      "elastic load balancer",
    ],
    resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
  },
  {
    keywords: ["subnet", "private subnet", "public subnet"],
    resourceType: RESOURCE_TYPES.EC2_SUBNET,
  },
  {
    keywords: ["route table", "routing table"],
    resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
  },
  {
    keywords: ["internet gateway", "igw"],
    resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
  },
  {
    keywords: ["nat gateway", "network address translation"],
    resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
  },
  {
    keywords: ["cloudwatch logs", "log group", "logging"],
    resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
  },
  {
    keywords: ["api gateway", "http api", "websocket api"],
    resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
  },
  {
    keywords: ["cloudwatch alarm", "metric alarm", "monitoring alarm"],
    resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
  },
  {
    keywords: ["route", "network route"],
    resourceType: RESOURCE_TYPES.EC2_ROUTE,
  },
  {
    keywords: ["efs", "elastic file system", "nfs file system"],
    resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,
  },
  {
    keywords: [
      "eventbridge rule",
      "event bridge rule",
      "events rule",
      "scheduled rule",
      "cron rule",
      "cloudwatch event rule",
    ],
    resourceType: RESOURCE_TYPES.EVENTS_RULE,
  },
  {
    keywords: [
      "eventbridge bus",
      "event bus",
      "custom event bus",
      "cross-account event bus",
      "saas partner event bus",
    ],
    resourceType: RESOURCE_TYPES.EVENTS_EVENT_BUS,
  },
  // A10 (2026-04-09): AWS::SNS::Subscription — promoted from
  // CCAPI_FALLBACK_TYPES to first-class. Keywords must not overlap
  // with the earlier "sns" entry for SNS_TOPIC — the classifier
  // returns on first match, so any "sns subscription" phrase would
  // be captured by the "sns" keyword before reaching this entry.
  // Putting this entry AFTER the topic entry would never match. We
  // therefore use unique multi-word phrases and move it to the
  // COMPOUND_CROSS_REF_KEYWORDS block below instead (those are
  // checked first). A placeholder here is kept for completeness but
  // intentionally uses phrases that don't overlap with "sns".
  {
    keywords: ["subscription to sns topic", "sns topic subscription"],
    resourceType: RESOURCE_TYPES.SNS_SUBSCRIPTION,
  },
];

// WV4-A: Compound cross-reference resources are auto-generated by the
// compound dispatcher (vpc-networking pattern), never requested directly.
// They need entries in this map for cross-system consistency tests, but
// must be matched FIRST so the unique multi-word phrases win against
// shorter substrings (e.g. "vpc gateway attachment" must not be classified
// as "VPC"). KEYWORD_TO_RESOURCE_TYPE_PRIORITY is checked before the
// regular table.
const COMPOUND_CROSS_REF_KEYWORDS: Array<{
  keywords: string[];
  resourceType: string;
}> = [
  {
    keywords: ["vpc gateway attachment", "vpcgatewayattachment"],
    resourceType: RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT,
  },
  {
    keywords: ["subnet route table association", "subnetroutetableassociation"],
    resourceType: RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
  },
  // EFS MountTarget is auto-generated by the (future) efs-with-vpc compound
  // dispatcher — never requested directly. Needs a unique multi-word phrase
  // that cannot be subsumed by shorter substrings in the regular table (e.g.
  // "mount target" must not be classified as "target group").
  {
    keywords: ["efs mount target", "efsmounttarget"],
    resourceType: RESOURCE_TYPES.EFS_MOUNT_TARGET,
  },
  // A10 (2026-04-09): SNS Subscription classification. Must run in
  // the priority block so the multi-word phrases here WIN against
  // the plain "sns" keyword in the regular table, which would
  // otherwise classify a "sns subscription" request as SNS_TOPIC.
  {
    keywords: [
      "sns subscription",
      "snssubscription",
      "topic subscription",
      "subscribe to topic",
      "subscribe to sns",
    ],
    resourceType: RESOURCE_TYPES.SNS_SUBSCRIPTION,
  },
  // 2026-04-14: RDS::DBSubnetGroup classification. Auto-generated by
  // the three-tier-web compound dispatcher — never user-requested
  // directly. Priority-block placement so "db subnet group" wins
  // against the bare "rds" keyword that would otherwise classify it
  // as RDS_DB_INSTANCE. Closes the coverage-consistency CI gap where
  // RDS_DB_SUBNET_GROUP was in SUPPORTED_TYPES_ARRAY but had no
  // classifier entry and no TYPE_TO_KEYWORD mapping.
  {
    keywords: [
      "db subnet group",
      "dbsubnetgroup",
      "rds subnet group",
      "database subnet group",
    ],
    resourceType: RESOURCE_TYPES.RDS_DB_SUBNET_GROUP,
  },
  // A11 (2026-04-09): KMS::Key customer-managed-key classification.
  // Put in the priority block so multi-word phrases like "kms key"
  // match before any future shorter "kms" keyword would. Distinct
  // from any other service — no collision risk.
  {
    keywords: [
      "kms key",
      "kmskey",
      "customer managed key",
      "customer-managed key",
      "cmk",
      "encryption key",
      "kms cmk",
    ],
    resourceType: RESOURCE_TYPES.KMS_KEY,
  },
  // A12 (2026-04-09): Events::Connection classification. Must be in
  // priority block because the unique phrases here would otherwise
  // be subsumed by "eventbridge rule" or "event bus" in the regular
  // table.
  {
    keywords: [
      "eventbridge connection",
      "events connection",
      "api connection",
      "webhook connection",
      "outbound api connection",
    ],
    resourceType: RESOURCE_TYPES.EVENTS_CONNECTION,
  },
  // A13 (2026-04-09): Events::ApiDestination classification. Same
  // priority-block reasoning.
  {
    keywords: [
      "api destination",
      "apidestination",
      "eventbridge destination",
      "outbound webhook",
      "webhook destination",
      "external api target",
    ],
    resourceType: RESOURCE_TYPES.EVENTS_API_DESTINATION,
  },
  // A14 (2026-04-09): CloudFront::Distribution classification. Priority
  // block so the unique phrases win — "cdn" / "cloudfront" are distinct
  // enough that no other entry in the regular table would match them.
  // NOTE: ORDER MATTERS. The OAC entry below MUST come before this
  // distribution entry because "cloudfront oac" and "origin access
  // control" both contain the substring "cloudfront" and would
  // otherwise be misclassified as CLOUDFRONT_DISTRIBUTION. The
  // classifier returns on first match within each block.
  {
    keywords: [
      "cloudfront",
      "cloud front",
      "cdn",
      "content delivery network",
      "cloudfront distribution",
      "edge cache",
    ],
    resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  },
];

// (f) 2026-04-09 Task 4b: classification for OAC + BucketPolicy. Kept
// in their own priority block that runs BEFORE the main CF block so
// the more-specific phrases win against bare "cloudfront" /
// "bucket". The static-website compound is the canonical consumer;
// standalone natural-language requests are rare but must still
// classify cleanly for cost estimation.
const TASK_4B_PRIORITY_KEYWORDS: Array<{
  keywords: string[];
  resourceType: string;
}> = [
  {
    keywords: [
      "cloudfront origin access control",
      "cloudfront oac",
      "origin access control",
      "oac for cloudfront",
      "oac for s3",
    ],
    resourceType: RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
  },
  {
    keywords: [
      "s3 bucket policy",
      "bucket policy",
      "s3 resource policy",
      "bucketpolicy",
    ],
    resourceType: RESOURCE_TYPES.S3_BUCKET_POLICY,
  },
];

/**
 * Classifies a natural language description into a CloudFormation resource type.
 * Uses case-insensitive keyword matching. Returns null if no match found.
 */
export function classifyResourceType(
  description: string | undefined | null,
): string | null {
  // Defensive: the upstream caller can pass undefined (e.g. empty MCP
  // request body or a missing TYPE_TO_KEYWORD entry). Return null
  // instead of throwing so cross-system consistency tests surface
  // missing-keyword gaps as clean failures rather than TypeErrors.
  if (typeof description !== "string" || description.length === 0) {
    return null;
  }
  const normalized = description.toLowerCase();
  // (f) 2026-04-09 Task 4b: OAC + BucketPolicy must run before the
  // main CloudFront block — otherwise "cloudfront origin access
  // control" matches the "cloudfront" keyword first and classifies
  // as CLOUDFRONT_DISTRIBUTION.
  for (const entry of TASK_4B_PRIORITY_KEYWORDS) {
    if (entry.keywords.some((kw) => normalized.includes(kw))) {
      return entry.resourceType;
    }
  }
  // WV4-A: check long multi-word compound cross-ref keywords first so they
  // are not pre-empted by shorter substrings in the regular table.
  for (const entry of COMPOUND_CROSS_REF_KEYWORDS) {
    if (entry.keywords.some((kw) => normalized.includes(kw))) {
      return entry.resourceType;
    }
  }
  for (const entry of KEYWORD_TO_RESOURCE_TYPE) {
    if (entry.keywords.some((kw) => normalized.includes(kw))) {
      return entry.resourceType;
    }
  }
  return null;
}

/**
 * Estimates the monthly cost for a resource type.
 * Uses the PricingStrategyRegistry from @assignee/core for local estimation.
 * Does NOT make any AWS API calls or run the LangGraph pipeline.
 *
 * @param resourceType - CloudFormation resource type (e.g. "AWS::S3::Bucket")
 * @param desiredState - Optional desired state for more accurate estimates
 * @returns Cost estimate result
 */
export function estimateCostForResource(
  resourceType: string,
  desiredState?: Record<string, unknown>,
): CostEstimateResult {
  const estimate: PricingEstimate = defaultPricingRegistry.estimate(
    resourceType,
    desiredState,
  );

  const freeTier = getFreeTierNote(resourceType);

  const result: CostEstimateResult = {
    resourceType,
    estimatedMonthlyCost: formatEstimate(estimate),
  };

  if (freeTier) {
    result.freeTierEligible = true;
    result.freeTierNote = freeTier.message;

    // If the estimate shows pricing unavailable but it's free-tier-eligible,
    // update the cost label to reflect that
    if (estimate.perMonth === null && estimate.isFree !== true) {
      result.estimatedMonthlyCost = "$0.00 (within free tier)";
    }
  }

  return result;
}

/**
 * Formats a PricingEstimate into a human-readable cost string.
 */
function formatEstimate(estimate: PricingEstimate): string {
  if (estimate.isFree) {
    return "$0.00 (always free)";
  }
  if (estimate.perMonth !== null) {
    return `~$${estimate.perMonth.toFixed(2)}/month`;
  }
  // Return the label from the pricing strategy (may contain formatted cost info)
  return estimate.label;
}
