/**
 * ARN-to-CloudFormation type mapping — single source of truth.
 *
 * Maps AWS service names (from ARN partition) to CloudFormation resource type
 * strings. Used by both CLI and MCP server for listing and resolving resources.
 *
 * @see Story 42.10 — zero magic strings policy
 */

import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
  LIST_RESOURCE_TYPES,
} from "./resource-types.js";
import { AWS_SERVICE_EXECUTE_API } from "./cfn-keys.js";

/**
 * Simple service-name to CFN type map for services with a single resource type.
 * Key: service name from ARN (e.g. "s3", "lambda").
 */
export const SERVICE_TYPE_MAP: Readonly<Record<string, string>> = {
  s3: RESOURCE_TYPES.S3_BUCKET,
  rds: RESOURCE_TYPES.RDS_DB_INSTANCE,
  dynamodb: RESOURCE_TYPES.DYNAMODB_TABLE,
  sqs: RESOURCE_TYPES.SQS_QUEUE,
  sns: RESOURCE_TYPES.SNS_TOPIC,
  // A1 — EFS (service name is "elasticfilesystem", not "efs")
  elasticfilesystem: RESOURCE_TYPES.EFS_FILE_SYSTEM,
  cloudformation: LIST_RESOURCE_TYPES.CLOUDFORMATION_STACK,
  logs: RESOURCE_TYPES.LOGS_LOG_GROUP,
  events: RESOURCE_TYPES.EVENTS_RULE,
  cloudfront: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  ecs: RESOURCE_TYPES.ECS_CLUSTER,
  eks: LIST_RESOURCE_TYPES.EKS_CLUSTER,
  elasticache: LIST_RESOURCE_TYPES.ELASTICACHE_CACHE_CLUSTER,
  kinesis: LIST_RESOURCE_TYPES.KINESIS_STREAM,
  secretsmanager: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
  stepfunctions: LIST_RESOURCE_TYPES.STEPFUNCTIONS_STATE_MACHINE,
  states: LIST_RESOURCE_TYPES.STEPFUNCTIONS_STATE_MACHINE,
} as const;

/**
 * Services with multiple resource types — resolved by ARN resource segment.
 * Key: service name, Value: map of resource-segment to CFN type.
 * Empty string key ("") matches when no specific segment matches.
 */
export const SERVICE_SUBTYPE_MAP: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  ec2: {
    instance: RESOURCE_TYPES.EC2_INSTANCE,
    vpc: RESOURCE_TYPES.EC2_VPC,
    subnet: RESOURCE_TYPES.EC2_SUBNET,
    "security-group": RESOURCE_TYPES.EC2_SECURITY_GROUP,
    "internet-gateway": RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
    "route-table": RESOURCE_TYPES.EC2_ROUTE_TABLE,
    natgateway: RESOURCE_TYPES.EC2_NAT_GATEWAY,
    "elastic-ip": COMPANION_RESOURCE_TYPES.EC2_EIP,
  },
  iam: {
    role: RESOURCE_TYPES.IAM_ROLE,
    policy: LIST_RESOURCE_TYPES.IAM_MANAGED_POLICY,
    user: LIST_RESOURCE_TYPES.IAM_USER,
    group: LIST_RESOURCE_TYPES.IAM_GROUP,
    "instance-profile": LIST_RESOURCE_TYPES.IAM_INSTANCE_PROFILE,
  },
  apigateway: {
    "/apis": RESOURCE_TYPES.APIGATEWAYV2_API,
    restapis: LIST_RESOURCE_TYPES.APIGATEWAY_REST_API,
  },
  [AWS_SERVICE_EXECUTE_API]: {
    "": RESOURCE_TYPES.APIGATEWAYV2_API,
  },
  elasticloadbalancing: {
    loadbalancer: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    targetgroup: LIST_RESOURCE_TYPES.ELBV2_TARGET_GROUP,
  },
  ecr: {
    repository: RESOURCE_TYPES.ECR_REPOSITORY,
  },
  cloudwatch: {
    alarm: RESOURCE_TYPES.CLOUDWATCH_ALARM,
  },
  ssm: {
    parameter: RESOURCE_TYPES.SSM_PARAMETER,
  },
  lambda: {
    "event-source-mapping": LIST_RESOURCE_TYPES.LAMBDA_EVENT_SOURCE_MAPPING,
    "": RESOURCE_TYPES.LAMBDA_FUNCTION,
  },
} as const;

/**
 * Converts an AWS service name and resource component from an ARN
 * into a CloudFormation-style type string.
 *
 * @param service - AWS service name from ARN (e.g. "s3", "ec2")
 * @param resourcePart - Resource section of the ARN (everything after the 5th colon)
 * @returns CloudFormation resource type string (e.g. "AWS::S3::Bucket")
 */
export function arnToCloudFormationType(
  service: string,
  resourcePart: string,
): string {
  // Check subtype map first (for services with multiple resource types)
  const subtypes = SERVICE_SUBTYPE_MAP[service];
  if (subtypes) {
    const segments = resourcePart.split(/[:/]/).filter(Boolean);
    const resourceSeg = segments[0] ?? "";
    if (resourcePart.startsWith("/")) {
      const prefixed = "/" + resourceSeg;
      if (subtypes[prefixed]) return subtypes[prefixed]!;
    }
    if (subtypes[resourceSeg]) return subtypes[resourceSeg]!;
    if (subtypes[""]) return subtypes[""]!;
  }

  // Simple service→type map
  const mapped = SERVICE_TYPE_MAP[service];
  if (mapped) return mapped;

  // Fallback: construct from service + resource
  const capitalizedService = service.charAt(0).toUpperCase() + service.slice(1);
  const resourceType = resourcePart.split(/[:/]/)[0] ?? "Resource";
  const capitalizedResource =
    resourceType.charAt(0).toUpperCase() + resourceType.slice(1);

  return `AWS::${capitalizedService}::${capitalizedResource}`;
}
