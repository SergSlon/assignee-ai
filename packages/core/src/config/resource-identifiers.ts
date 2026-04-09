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
  // Sprint F: Tier 1 resources (Epic 25)
  [RESOURCE_TYPES.LOGS_LOG_GROUP]: "LogGroupName",
  [RESOURCE_TYPES.EC2_INTERNET_GATEWAY]: "InternetGatewayId",
  [RESOURCE_TYPES.EC2_ROUTE_TABLE]: "RouteTableId",
  [RESOURCE_TYPES.EC2_ROUTE]: "RouteTableId",
  [RESOURCE_TYPES.EC2_NAT_GATEWAY]: "NatGatewayId",
  // Sprint G: Tier 2 resources (Epic 26)
  [RESOURCE_TYPES.APIGATEWAYV2_API]: "ApiId",
  [RESOURCE_TYPES.CLOUDWATCH_ALARM]: "AlarmName",
  [RESOURCE_TYPES.SECRETSMANAGER_SECRET]: "Name",
  // WV4-A: VPC compound provisioning support. Both types use composite
  // CloudControl identifiers (VPCGatewayAttachment uses
  // "VpcId|InternetGatewayId", SubnetRouteTableAssociation uses "AssociationId")
  // — getPrimaryIdentifier returns undefined for these and the state guard
  // skips Read-Before-Write, which is correct for cross-reference resources.
  [RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT]: "AttachmentId",
  [RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION]: "Id",
  // A1 (2026-04-08): EFS primary identifier is the auto-generated
  // FileSystemId (fs-xxxxxxxx). Not present in desiredState at plan
  // time — state guard will skip Read-Before-Write for EFS, same as
  // the other auto-ID types above.
  [RESOURCE_TYPES.EFS_FILE_SYSTEM]: "FileSystemId",
  // A1 follow-up: EFS::MountTarget primary identifier is
  // /properties/Id (fsmt-xxxxxxxx) — auto-generated like most
  // network attachment resources. State guard skips it.
  [RESOURCE_TYPES.EFS_MOUNT_TARGET]: "Id",
  // A8 (2026-04-08): AWS::Events::Rule primary identifier is the
  // auto-generated Arn (readOnly in the CCAPI schema). The Name is
  // createOnly but not the primary ID — if users supply a Name we
  // still can't use it for GetResource because CCAPI keys on the
  // Arn. State guard will skip Read-Before-Write because Arn is
  // never present in desiredState at plan time.
  [RESOURCE_TYPES.EVENTS_RULE]: "Arn",
  // A9 (2026-04-09): AWS::Events::EventBus primary identifier is
  // the user-supplied Name (createOnly + required). Unlike
  // Events::Rule, the Name IS the primary ID — CCAPI keys on it,
  // and the user supplies it at plan time, so the state guard
  // CAN do Read-Before-Write for EventBus and catch existing-bus
  // collisions before CCAPI throws AlreadyExists.
  [RESOURCE_TYPES.EVENTS_EVENT_BUS]: "Name",
  // A10 (2026-04-09): AWS::SNS::Subscription primary identifier is
  // the auto-generated subscription Arn (readOnly in the CCAPI
  // schema). TopicArn + Protocol + Endpoint are all createOnly and
  // together determine the Arn, but the Arn itself is never
  // present in desiredState at plan time — state guard skips the
  // Read-Before-Write check, mirroring Events::Rule.
  [RESOURCE_TYPES.SNS_SUBSCRIPTION]: "Arn",
  // A11 (2026-04-09): AWS::KMS::Key primary identifier is the
  // auto-generated KeyId (UUID, readOnly in the CCAPI schema).
  // The human-friendly Description is NOT the primary identifier
  // — CCAPI keys on KeyId, which is never present in desiredState
  // at plan time, so the state guard skips Read-Before-Write for
  // this type (same pattern as EFS::FileSystem and VPC).
  [RESOURCE_TYPES.KMS_KEY]: "KeyId",
  // A12 (2026-04-09): AWS::Events::Connection primary identifier is
  // the user-supplied Name (createOnly). Same pattern as
  // Events::EventBus — the Name IS the primary ID, CCAPI keys on it,
  // so the state guard CAN do Read-Before-Write and catch existing-
  // connection collisions before CCAPI throws AlreadyExists.
  [RESOURCE_TYPES.EVENTS_CONNECTION]: "Name",
  // A13 (2026-04-09): AWS::Events::ApiDestination primary identifier
  // is the user-supplied Name (createOnly). Same Read-Before-Write
  // semantics as Events::Connection above.
  [RESOURCE_TYPES.EVENTS_API_DESTINATION]: "Name",
  // A14 (2026-04-09): AWS::CloudFront::Distribution primary
  // identifier is the auto-generated Id (readOnly in the CCAPI
  // schema, alphanumeric 14-char string like "E1ABCDEFG1234H").
  // The Id is never present in desiredState at plan time, so the
  // state guard skips Read-Before-Write for this type — same
  // pattern as EFS::FileSystem and KMS::Key.
  [RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION]: "Id",
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
