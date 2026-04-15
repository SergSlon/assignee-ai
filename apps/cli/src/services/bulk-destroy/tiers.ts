/**
 * Destruction tier mapping + CCAPI typeName validation.
 *
 * Lower tier = destroyed first (dependents before foundations).
 * See `planBulkDestroy` for how tiers drive the destroy order.
 *
 * @see Story 36.2
 */

import {
  RESOURCE_TYPES,
  LIST_RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "@assignee/core";

/**
 * Dependency tier mapping for destruction order.
 * Lower tier = destroyed first (dependents before foundations).
 */
export const DESTROY_TIER: Record<string, number> = {
  // Tier 1: Leaf resources and CDN (no dependents, or must be removed before origin)
  [RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT]: 1, // detach before IGW/VPC delete
  [RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION]: 1, // disassociate before RT/subnet delete
  [RESOURCE_TYPES.EC2_ROUTE]: 1,
  [RESOURCE_TYPES.CLOUDWATCH_ALARM]: 1,
  [RESOURCE_TYPES.SECRETSMANAGER_SECRET]: 1,
  [RESOURCE_TYPES.LOGS_LOG_GROUP]: 1,
  [RESOURCE_TYPES.SSM_PARAMETER]: 1,
  // (f) 2026-04-09 Task 4b: static-website compound destroy order.
  // The BucketPolicy holds an aws:SourceArn reference to the
  // distribution — the policy must be deleted BEFORE both the
  // bucket (S3 ordering) and the distribution (clean reference
  // semantics). Tier 0 goes first, then the distribution at tier 1
  // (disabled + deleted), then the OAC at tier 2 (CloudFront
  // rejects OAC deletion while an attached distribution is still
  // active), then the bucket at tier 5.
  [RESOURCE_TYPES.S3_BUCKET_POLICY]: 0,
  [RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION]: 1, // Must be disabled/deleted before S3 bucket
  [RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL]: 2,
  // Tier 2: Service resources + leaf dependents that must go before parents
  [RESOURCE_TYPES.LAMBDA_FUNCTION]: 2,
  [RESOURCE_TYPES.SQS_QUEUE]: 2,
  [RESOURCE_TYPES.SNS_TOPIC]: 2,
  [RESOURCE_TYPES.DYNAMODB_TABLE]: 2,
  [RESOURCE_TYPES.APIGATEWAYV2_API]: 2,
  // 2026-04-12: EFS MountTarget must be deleted BEFORE EFS FileSystem.
  // MountTargets are leaf resources (no dependents), FileSystem rejects
  // delete while mount targets exist ("has mount targets" 409 error).
  [RESOURCE_TYPES.EFS_MOUNT_TARGET]: 2,
  [RESOURCE_TYPES.EFS_FILE_SYSTEM]: 3,
  // EventBridge resources
  [RESOURCE_TYPES.EVENTS_RULE]: 2,
  [RESOURCE_TYPES.EVENTS_EVENT_BUS]: 3,
  [RESOURCE_TYPES.KMS_KEY]: 2,
  // Tier 3: Compute/DB/Network services
  [RESOURCE_TYPES.EC2_INSTANCE]: 3,
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: 3,
  // DBSubnetGroup must be deleted AFTER RDS instance (tier 3) AND BEFORE
  // subnets (tier 4) — RDS rejects DBSubnetGroup deletion while an
  // instance references it, and subnet deletion fails with
  // DependencyViolation if a DBSubnetGroup still references it.
  // Architect WARNING #3: previously DBSubnetGroup and subnets shared
  // tier 4, letting parallel-destroy race subnets ahead of the group.
  // Decimal tier sits between the two integer tiers without renumbering
  // everything after it.
  [RESOURCE_TYPES.RDS_DB_SUBNET_GROUP]: 3.5,
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: 3,
  [RESOURCE_TYPES.EC2_NAT_GATEWAY]: 3,
  [RESOURCE_TYPES.ECR_REPOSITORY]: 3,
  [RESOURCE_TYPES.ECS_CLUSTER]: 3,
  // Tier 4: Network infrastructure
  [RESOURCE_TYPES.EC2_SECURITY_GROUP]: 4,
  [RESOURCE_TYPES.EC2_SUBNET]: 4,
  [RESOURCE_TYPES.EC2_INTERNET_GATEWAY]: 4,
  [RESOURCE_TYPES.EC2_ROUTE_TABLE]: 4,
  // Wave 19 Bug #6: EIP must be released AFTER NAT Gateway (tier 3) but
  // before VPC (tier 5). EIP is technically a companion resource type,
  // but it's the only one in COMPANION_RESOURCE_TYPES that ends up
  // standalone-tagged in AWS — every NAT Gateway compound run leaves an
  // EIP behind that needs explicit cleanup. Tier 4 puts it alongside the
  // network infrastructure that holds it, after the NAT Gateway that
  // references it. CCAPI supports `AWS::EC2::EIP` deletion via the
  // standard destroy path. Combined with the managed-by=assignee-ai tag
  // added in resource-provisioner.ts (also Wave 19 Bug #6), this finally
  // closes the EIP leak loop observed during the 2026-04-08 live smoke.
  [COMPANION_RESOURCE_TYPES.EC2_EIP]: 4,
  // Tier 5: Foundations
  [RESOURCE_TYPES.S3_BUCKET]: 5,
  [RESOURCE_TYPES.EC2_VPC]: 5,
  // Tier 6: Identity (opt-in only)
  [RESOURCE_TYPES.IAM_ROLE]: 6,
  [LIST_RESOURCE_TYPES.IAM_MANAGED_POLICY]: 6,
};

/** Default tier for resource types not in the DESTROY_TIER map. */
export const DEFAULT_TIER = 3;

/**
 * CloudControl API typeName validation pattern — matches the CCAPI constraint:
 * `[A-Za-z0-9]{2,64}::[A-Za-z0-9]{2,64}::[A-Za-z0-9]{2,64}`
 * RGTA returns non-conforming types (e.g. "AWS::Backup::Recovery-point" with
 * lowercase hyphen) that must be filtered before reaching CCAPI delete calls.
 */
// Exported for unit testing — buildPlanFromResources uses this to drop
// non-conforming RGTA types before they reach CCAPI delete calls.
export const CCAPI_TYPE_PATTERN =
  /^[A-Za-z0-9]{2,64}::[A-Za-z0-9]{2,64}::[A-Za-z0-9]{2,64}$/;

/** IAM resource type prefixes — used to identify IAM resources for opt-in filtering. */
export const IAM_TYPE_PREFIX = "AWS::IAM::";

/**
 * Determines whether a resource type is an IAM type.
 */
export function isIamType(resourceType: string): boolean {
  return resourceType.startsWith(IAM_TYPE_PREFIX);
}
