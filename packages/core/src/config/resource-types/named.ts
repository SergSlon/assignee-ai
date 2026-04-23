/**
 * Named constants for supported resource types — use for readable
 * comparisons (e.g. RESOURCE_TYPES.S3_BUCKET) instead of literal strings.
 *
 * Split out of `resource-types.ts` for SRP / file-size compliance.
 */

import type { ResourceType } from "./supported.js";

/** Named constants for supported resource types. */
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
  // Sprint F: Tier 1 resources (Epic 25)
  LOGS_LOG_GROUP: "AWS::Logs::LogGroup",
  EC2_INTERNET_GATEWAY: "AWS::EC2::InternetGateway",
  EC2_ROUTE_TABLE: "AWS::EC2::RouteTable",
  EC2_ROUTE: "AWS::EC2::Route",
  EC2_NAT_GATEWAY: "AWS::EC2::NatGateway",
  // Sprint G: Tier 2 resources (Epic 26)
  APIGATEWAYV2_API: "AWS::ApiGatewayV2::Api",
  CLOUDWATCH_ALARM: "AWS::CloudWatch::Alarm",
  SECRETSMANAGER_SECRET: "AWS::SecretsManager::Secret",
  // WV4-A: VPC compound provisioning support
  EC2_VPC_GATEWAY_ATTACHMENT: "AWS::EC2::VPCGatewayAttachment",
  EC2_SUBNET_ROUTE_TABLE_ASSOCIATION: "AWS::EC2::SubnetRouteTableAssociation",
  // A1 (2026-04-08)
  EFS_FILE_SYSTEM: "AWS::EFS::FileSystem",
  EFS_MOUNT_TARGET: "AWS::EFS::MountTarget",
  // A8 (2026-04-08)
  EVENTS_RULE: "AWS::Events::Rule",
  // A9 (2026-04-09)
  EVENTS_EVENT_BUS: "AWS::Events::EventBus",
  // A10 (2026-04-09)
  SNS_SUBSCRIPTION: "AWS::SNS::Subscription",
  // A11 (2026-04-09)
  KMS_KEY: "AWS::KMS::Key",
  // A12 (2026-04-09)
  EVENTS_CONNECTION: "AWS::Events::Connection",
  // A13 (2026-04-09)
  EVENTS_API_DESTINATION: "AWS::Events::ApiDestination",
  // A14 (2026-04-09)
  CLOUDFRONT_DISTRIBUTION: "AWS::CloudFront::Distribution",
  // (f) 2026-04-09 Task 4b
  CLOUDFRONT_ORIGIN_ACCESS_CONTROL: "AWS::CloudFront::OriginAccessControl",
  // (f) 2026-04-09 Task 4b
  S3_BUCKET_POLICY: "AWS::S3::BucketPolicy",
  // 2026-04-13: RDS::DBSubnetGroup for three-tier-web compound
  RDS_DB_SUBNET_GROUP: "AWS::RDS::DBSubnetGroup",
  // e98.W5.N5 (B-03) — EIP promoted from companion to first-class.
  // A standalone `Create an Elastic IP` intent routes through the
  // ec2-eip plugin now. The COMPANION_RESOURCE_TYPES.EC2_EIP alias
  // in `./companion.ts` is retained for backwards-compat with
  // nat-gateway companion callers that auto-allocate inline.
  EC2_EIP: "AWS::EC2::EIP",
} as const satisfies Record<string, ResourceType>;
