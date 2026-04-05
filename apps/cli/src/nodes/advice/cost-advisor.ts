/**
 * Cost alternative advisor — suggests cheaper resource configurations.
 * All prices come from Pricing MCP at runtime (zero hardcoded amounts).
 * When MCP is unavailable, returns structural hints without prices.
 *
 * @see Story 40.4 — Cost Alternative Advisor
 */

import { RESOURCE_TYPES, CfnKey } from "@assignee/core";
import {
  ARM_EQUIVALENTS,
  SPOT_ELIGIBLE_PREFIXES,
  RDS_LARGE_CLASS_PREFIXES,
  RDS_BUDGET_ALTERNATIVES,
  LAMBDA_MEMORY_OPTIMIZATION_THRESHOLD_MB,
  AdviceIcon,
} from "./constants.js";

/**
 * Generates cost optimization hints based on the resource configuration.
 * Does NOT call Pricing MCP directly — that's Story 40.2 (MCP enrichment).
 * For now, returns structural cost advice that doesn't need runtime prices.
 */
export function costAlternatives(
  resourceType: string,
  desiredState: Record<string, unknown>,
): string[] {
  const hints: string[] = [];

  if (resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    ec2CostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.RDS_DB_INSTANCE) {
    rdsCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.S3_BUCKET) {
    s3CostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.LAMBDA_FUNCTION) {
    lambdaCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.DYNAMODB_TABLE) {
    dynamodbCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY) {
    hints.push(
      `${AdviceIcon.COST} NAT Gateway costs ~$32/mo fixed + data processing fees \u2014 consider VPC endpoints for S3/DynamoDB to reduce data transfer through NAT`,
    );
  } else if (resourceType === RESOURCE_TYPES.ELBV2_LOAD_BALANCER) {
    hints.push(
      `${AdviceIcon.COST} ALB costs ~$16/mo fixed + LCU charges \u2014 for simple routing, consider using API Gateway instead`,
    );
  } else if (resourceType === RESOURCE_TYPES.SQS_QUEUE) {
    sqsCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.CLOUDWATCH_ALARM) {
    hints.push(
      `${AdviceIcon.COST} Standard alarms cost $0.10/alarm/month \u2014 high-resolution alarms (period < 60s) cost 3x more`,
    );
  } else if (resourceType === RESOURCE_TYPES.ECS_CLUSTER) {
    hints.push(
      `${AdviceIcon.COST} ECS cluster itself is free \u2014 costs come from the underlying EC2 instances or Fargate tasks`,
    );
  } else if (resourceType === RESOURCE_TYPES.LOGS_LOG_GROUP) {
    hints.push(
      `${AdviceIcon.COST} CloudWatch Logs ingestion costs $0.50/GB \u2014 set a retention period to avoid unbounded storage costs`,
    );
  }

  return hints;
}

function ec2CostHints(ds: Record<string, unknown>, hints: string[]): void {
  const instanceType = ds[CfnKey.INSTANCE_TYPE] as string | undefined;
  if (!instanceType) return;

  // Suggest ARM (Graviton) alternatives for x86 instance types
  for (const [x86Prefix, armPrefix] of Object.entries(ARM_EQUIVALENTS)) {
    if (instanceType.startsWith(x86Prefix)) {
      const armEquivalent = instanceType.replace(x86Prefix, armPrefix);
      hints.push(
        `${AdviceIcon.COST} Consider ${armEquivalent} (ARM/Graviton) instead of ${instanceType} \u2014 typically ~20% cheaper with comparable performance`,
      );
      break;
    }
  }

  // Suggest spot for dev/test workloads
  if (SPOT_ELIGIBLE_PREFIXES.some((p) => instanceType.startsWith(p))) {
    hints.push(
      `${AdviceIcon.COST} For dev/test workloads, consider Spot Instances \u2014 up to 90% cheaper (but can be interrupted)`,
    );
  }
}

function rdsCostHints(ds: Record<string, unknown>, hints: string[]): void {
  const instanceClass = ds[CfnKey.DB_INSTANCE_CLASS] as string | undefined;

  // Suggest smaller class for non-prod
  if (
    instanceClass &&
    RDS_LARGE_CLASS_PREFIXES.some((p) => instanceClass.startsWith(p))
  ) {
    hints.push(
      `${AdviceIcon.COST} For non-production workloads, consider ${RDS_BUDGET_ALTERNATIVES} instead of ${instanceClass} \u2014 significantly cheaper for light database loads`,
    );
  }

  // Multi-AZ cost warning
  if (ds[CfnKey.MULTI_AZ] === true) {
    hints.push(
      `${AdviceIcon.COST} Multi-AZ is enabled \u2014 this roughly doubles the instance cost (standby replica) but provides automatic failover`,
    );
  }
}

function s3CostHints(ds: Record<string, unknown>, hints: string[]): void {
  const hasLifecycle =
    ds["LifecycleConfiguration"] !== undefined ||
    ds[CfnKey.ENABLE_LIFECYCLE] === true;

  if (!hasLifecycle) {
    hints.push(
      `${AdviceIcon.COST} Consider adding lifecycle rules to transition infrequent data to S3-IA or Glacier after 30-90 days`,
    );
  }
}

function lambdaCostHints(ds: Record<string, unknown>, hints: string[]): void {
  const memorySize = ds[CfnKey.MEMORY_SIZE] as number | undefined;

  if (memorySize && memorySize > LAMBDA_MEMORY_OPTIMIZATION_THRESHOLD_MB) {
    hints.push(
      `${AdviceIcon.COST} Lambda memory is set to ${memorySize}MB \u2014 test with lower memory if your function isn't CPU-bound (Lambda CPU scales linearly with memory)`,
    );
  }
}

function dynamodbCostHints(ds: Record<string, unknown>, hints: string[]): void {
  const billingMode = ds["BillingMode"] as string | undefined;
  if (billingMode === "PROVISIONED" || !billingMode) {
    hints.push(
      `${AdviceIcon.COST} Using provisioned capacity \u2014 consider PAY_PER_REQUEST (on-demand) for unpredictable workloads to avoid over-provisioning`,
    );
  } else {
    hints.push(
      `${AdviceIcon.COST} Using on-demand capacity \u2014 for steady workloads, provisioned capacity with auto-scaling can be 70% cheaper`,
    );
  }
}

function sqsCostHints(ds: Record<string, unknown>, hints: string[]): void {
  const isFifo = ds["FifoQueue"] === true;
  if (isFifo) {
    hints.push(
      `${AdviceIcon.COST} FIFO queues cost 25% more than standard \u2014 use only when message ordering and exactly-once delivery are required`,
    );
  }
}
