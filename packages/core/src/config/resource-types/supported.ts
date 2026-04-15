/**
 * AWS CloudFormation resource types fully supported by the POC phase.
 * Split out of `resource-types.ts` for SRP / file-size compliance.
 * This file owns the SUPPORTED_TYPES_ARRAY tuple and the ResourceType union.
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
  // Sprint F: Tier 1 resources (Epic 25)
  "AWS::Logs::LogGroup",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::RouteTable",
  "AWS::EC2::Route",
  "AWS::EC2::NatGateway",
  // Sprint G: Tier 2 resources (Epic 26)
  "AWS::ApiGatewayV2::Api",
  "AWS::CloudWatch::Alarm",
  "AWS::SecretsManager::Secret",
  // WV4-A: VPC compound provisioning support (was provisionable: false
  // before the marker resolver landed in plan-generator.ts)
  "AWS::EC2::VPCGatewayAttachment",
  "AWS::EC2::SubnetRouteTableAssociation",
  // A1 (2026-04-08): first-class EFS support.
  "AWS::EFS::FileSystem",
  "AWS::EFS::MountTarget",
  // A8 (2026-04-08): EventBridge Rule first-class.
  "AWS::Events::Rule",
  // A9 (2026-04-09): AWS::Events::EventBus first-class.
  "AWS::Events::EventBus",
  // A10 (2026-04-09): AWS::SNS::Subscription first-class.
  "AWS::SNS::Subscription",
  // A11 (2026-04-09): AWS::KMS::Key first-class.
  "AWS::KMS::Key",
  // A12 (2026-04-09): AWS::Events::Connection first-class.
  "AWS::Events::Connection",
  // A13 (2026-04-09): AWS::Events::ApiDestination first-class.
  "AWS::Events::ApiDestination",
  // A14 (2026-04-09): AWS::CloudFront::Distribution first-class.
  "AWS::CloudFront::Distribution",
  // (f) 2026-04-09 Task 4b: AWS::CloudFront::OriginAccessControl first-class.
  "AWS::CloudFront::OriginAccessControl",
  // (f) 2026-04-09 Task 4b: AWS::S3::BucketPolicy first-class.
  "AWS::S3::BucketPolicy",
  // 2026-04-13: RDS::DBSubnetGroup first-class.
  "AWS::RDS::DBSubnetGroup",
] as const;

/** Union of all supported CloudFormation resource type strings. Derived from SUPPORTED_TYPES_ARRAY. */
export type ResourceType = (typeof SUPPORTED_TYPES_ARRAY)[number];

/** Ordered array of all resource types supported in the POC phase. */
export const SUPPORTED_POC_TYPES: ResourceType[] = [...SUPPORTED_TYPES_ARRAY];
