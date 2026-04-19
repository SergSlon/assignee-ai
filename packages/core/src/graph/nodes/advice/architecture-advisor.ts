/**
 * Architecture advisor for compound patterns — suggests missing companion components.
 * Only fires in compound mode (when resourcePattern is defined).
 *
 * @see Story 40.6 — Architecture Advisor for Compound Patterns
 */

import { RESOURCE_TYPES } from "@/index.js";
import { AdviceIcon } from "./constants.js";
import type { ArchitecturePattern, ResourceSpec } from "@/index.js";

/** Companion check: resource type that should be present in a pattern. */
interface CompanionCheck {
  resourceType: string;
  hint: string;
}

/**
 * Pattern → expected companion resources map.
 * Each entry defines what resources should typically accompany a pattern.
 */
const PATTERN_COMPANIONS: Record<string, CompanionCheck[]> = {
  "vpc-networking": [
    {
      resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
      hint: "Consider adding a NAT Gateway for private subnet internet access (required for private instances to reach AWS services)",
    },
  ],
  "vpc-public-only": [
    {
      resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
      hint: "Consider adding CloudWatch Flow Logs for VPC traffic monitoring and security auditing",
    },
  ],
  "serverless-api": [
    {
      resourceType: RESOURCE_TYPES.SQS_QUEUE,
      hint: "Consider adding an SQS Dead Letter Queue for the Lambda function to capture failed invocations for debugging",
    },
    {
      resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
      hint: "Consider adding CloudWatch Alarms for Lambda error rate and API Gateway 5xx rate to detect issues early",
    },
  ],
  "three-tier-web": [
    {
      resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
      hint: "Consider adding CloudWatch Alarms for EC2 CPU utilization, RDS connections, and ALB unhealthy host count",
    },
  ],
  "container-service": [
    {
      resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
      hint: "Consider using Secrets Manager for container environment secrets instead of plaintext environment variables",
    },
    {
      resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
      hint: "Consider adding CloudWatch Alarms for ECS task health and CPU/memory utilization",
    },
  ],
  "message-processing": [
    {
      resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
      hint: "Consider adding CloudWatch Alarms for queue depth monitoring to detect processing backlogs",
    },
  ],
  "static-website": [
    {
      resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
      hint: "Consider adding WAF integration for CloudFront to protect against web exploits",
    },
  ],
};

/**
 * Analyzes a compound pattern for missing companion resources.
 * Returns empty array for standalone (non-compound) resources.
 */
export function architectureAdvisor(
  pattern: ArchitecturePattern | undefined,
  resourceQueue: ResourceSpec[] | undefined,
): string[] {
  if (!pattern || !resourceQueue) return [];

  const patternId = pattern.patternId;
  const companions = PATTERN_COMPANIONS[patternId];
  if (!companions) return [];

  // Build set of resource types already in the queue
  const presentTypes = new Set(resourceQueue.map((r) => r.resourceType));

  const hints: string[] = [];
  for (const companion of companions) {
    if (!presentTypes.has(companion.resourceType)) {
      hints.push(`${AdviceIcon.ARCHITECTURE} ${companion.hint}`);
    }
  }

  return hints;
}
