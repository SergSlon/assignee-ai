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
];

/**
 * Classifies a natural language description into a CloudFormation resource type.
 * Uses case-insensitive keyword matching. Returns null if no match found.
 */
export function classifyResourceType(description: string): string | null {
  const normalized = description.toLowerCase();
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
