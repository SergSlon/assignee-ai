/**
 * AWS CloudFormation resource type constants for the POC phase.
 * Single source of truth — used by intent_parser, schema_fetcher, resource_provisioner,
 * preflight_guard, and (in MVP) the policy validation engine.
 *
 * @see project-context.md — No Magic Strings section
 */

/** Const tuple of all supported resource types — the single source of truth for z.enum() and runtime checks. */
export const SUPPORTED_TYPES_ARRAY = [
  "AWS::S3::Bucket",
  "AWS::SSM::Parameter",
  "AWS::IAM::Role",
  "AWS::EC2::Instance",
  "AWS::RDS::DBInstance",
  "AWS::Lambda::Function",
  // Story 8.1: additional types for compound architecture patterns
  "AWS::EC2::VPC",
  "AWS::EC2::Subnet",
  "AWS::EC2::SecurityGroup",
  "AWS::DynamoDB::Table",
  "AWS::SQS::Queue",
  "AWS::SNS::Topic",
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::ECS::Cluster",
  "AWS::ECR::Repository",
] as const;

/** Union of all supported CloudFormation resource type strings. Derived from SUPPORTED_TYPES_ARRAY. */
export type ResourceType = (typeof SUPPORTED_TYPES_ARRAY)[number];

/** Named constants for supported resource types — use for readable comparisons (e.g. RESOURCE_TYPES.S3_BUCKET). */
export const RESOURCE_TYPES = {
  S3_BUCKET: "AWS::S3::Bucket",
  SSM_PARAMETER: "AWS::SSM::Parameter",
  IAM_ROLE: "AWS::IAM::Role",
  EC2_INSTANCE: "AWS::EC2::Instance",
  RDS_DB_INSTANCE: "AWS::RDS::DBInstance",
  LAMBDA_FUNCTION: "AWS::Lambda::Function",
  // Story 8.1: additional types for compound architecture patterns
  EC2_VPC: "AWS::EC2::VPC",
  EC2_SUBNET: "AWS::EC2::Subnet",
  EC2_SECURITY_GROUP: "AWS::EC2::SecurityGroup",
  DYNAMODB_TABLE: "AWS::DynamoDB::Table",
  SQS_QUEUE: "AWS::SQS::Queue",
  SNS_TOPIC: "AWS::SNS::Topic",
  ELBV2_LOAD_BALANCER: "AWS::ElasticLoadBalancingV2::LoadBalancer",
  ECS_CLUSTER: "AWS::ECS::Cluster",
  ECR_REPOSITORY: "AWS::ECR::Repository",
} as const satisfies Record<string, ResourceType>;

/** Ordered array of all resource types supported in the POC phase. */
export const SUPPORTED_POC_TYPES =
  SUPPORTED_TYPES_ARRAY as unknown as ResourceType[];
