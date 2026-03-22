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

import { defaultPricingRegistry, type PricingEstimate } from "@assignee/core";
import { getFreeTierNote, type FreeTierInfo } from "./free-tier.js";

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
    resourceType: "AWS::S3::Bucket",
  },
  {
    keywords: ["lambda", "serverless function", "function as a service"],
    resourceType: "AWS::Lambda::Function",
  },
  {
    keywords: ["dynamodb", "dynamo", "nosql table"],
    resourceType: "AWS::DynamoDB::Table",
  },
  {
    keywords: ["ec2", "virtual machine", "compute instance"],
    resourceType: "AWS::EC2::Instance",
  },
  {
    keywords: ["rds", "relational database", "postgresql", "mysql", "aurora"],
    resourceType: "AWS::RDS::DBInstance",
  },
  {
    keywords: ["sqs", "message queue", "queue service"],
    resourceType: "AWS::SQS::Queue",
  },
  {
    keywords: ["sns", "notification", "pub/sub", "publish subscribe"],
    resourceType: "AWS::SNS::Topic",
  },
  {
    keywords: ["iam role", "execution role", "service role"],
    resourceType: "AWS::IAM::Role",
  },
  {
    keywords: ["ssm parameter", "parameter store", "systems manager parameter"],
    resourceType: "AWS::SSM::Parameter",
  },
  {
    keywords: ["ecs", "container service", "fargate"],
    resourceType: "AWS::ECS::Cluster",
  },
  {
    keywords: ["ecr", "container registry", "docker registry"],
    resourceType: "AWS::ECR::Repository",
  },
  {
    keywords: ["vpc", "virtual private cloud", "network"],
    resourceType: "AWS::EC2::VPC",
  },
  {
    keywords: ["security group", "firewall"],
    resourceType: "AWS::EC2::SecurityGroup",
  },
  {
    keywords: ["load balancer", "alb", "elb"],
    resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
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
