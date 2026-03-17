/**
 * Maps each POC resource type to its CloudFormation primary identifier key.
 * Used by resource_provisioner State Guard (FR-15 Read-Before-Write) to extract
 * the identifier from desiredState before calling GetResource.
 *
 * @see implementation-artifacts/2-2-implement-resource-provisioner-node-with-state-guard.md
 */

import { RESOURCE_TYPES, type ResourceType } from "./resource-types.js";

export const RESOURCE_IDENTIFIER_KEYS: Record<ResourceType, string> = {
  [RESOURCE_TYPES.S3_BUCKET]: "BucketName",
  [RESOURCE_TYPES.SSM_PARAMETER]: "Name",
  [RESOURCE_TYPES.IAM_ROLE]: "RoleName",
  [RESOURCE_TYPES.EC2_INSTANCE]: "InstanceId",
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: "DBInstanceIdentifier",
  [RESOURCE_TYPES.LAMBDA_FUNCTION]: "FunctionName",
  // Story 8.1: additional types for compound architecture patterns
  // Note: auto-generated identifiers (VpcId, SubnetId, etc.) are not present in desiredState;
  // state guard skips Read-Before-Write check when getPrimaryIdentifier returns undefined.
  [RESOURCE_TYPES.EC2_VPC]: "VpcId",
  [RESOURCE_TYPES.EC2_SUBNET]: "SubnetId",
  [RESOURCE_TYPES.EC2_SECURITY_GROUP]: "GroupId",
  [RESOURCE_TYPES.DYNAMODB_TABLE]: "TableName",
  [RESOURCE_TYPES.SQS_QUEUE]: "QueueUrl",
  [RESOURCE_TYPES.SNS_TOPIC]: "TopicArn",
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: "LoadBalancerArn",
  [RESOURCE_TYPES.ECS_CLUSTER]: "Arn",
  [RESOURCE_TYPES.ECR_REPOSITORY]: "RepositoryName",
} as const;

/**
 * Returns the primary identifier value extracted from a desiredState object
 * for the given resource type. Returns `undefined` if type has no known mapping.
 */
export function getPrimaryIdentifier(
  resourceType: ResourceType,
  desiredState: Record<string, unknown>,
): string | undefined {
  const key = RESOURCE_IDENTIFIER_KEYS[resourceType];
  if (!key) return undefined;
  const val = desiredState[key];
  return typeof val === "string" ? val : undefined;
}
