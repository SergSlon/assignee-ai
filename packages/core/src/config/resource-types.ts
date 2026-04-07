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
} as const satisfies Record<string, ResourceType>;

/** Ordered array of all resource types supported in the POC phase. */
export const SUPPORTED_POC_TYPES: ResourceType[] = [...SUPPORTED_TYPES_ARRAY];

// ── CCAPI Fallback Types (Story 7.7) ────────────────────────────────────────
// Resource types that cannot be provisioned via Cloud Control API.
// These are routed to SDK-specific fallback handlers or rejected with a redirect message.

/** All resource types known to have CCAPI gaps. */
export const CCAPI_FALLBACK_TYPES = {
  LAMBDA_EVENT_SOURCE_MAPPING: "AWS::Lambda::EventSourceMapping",
  SNS_SUBSCRIPTION: "AWS::SNS::Subscription",
  LAMBDA_PERMISSION: "AWS::Lambda::Permission",
  ELASTICACHE_REPLICATION_GROUP: "AWS::ElastiCache::ReplicationGroup",
} as const;

// ── Companion Resource Types ────────────────────────────────────────────────
// Resource types used only as companions (auto-provisioned alongside a primary resource).

/** Named constants for companion-only resource types that are not independently provisioned. */
export const COMPANION_RESOURCE_TYPES = {
  EC2_EIP: "AWS::EC2::EIP",
  EC2_VPC_GATEWAY_ATTACHMENT: "AWS::EC2::VPCGatewayAttachment",
  SECRETSMANAGER_SECRET_TARGET_ATTACHMENT:
    "AWS::SecretsManager::SecretTargetAttachment",
  EC2_SUBNET_ROUTE_TABLE_ASSOCIATION: "AWS::EC2::SubnetRouteTableAssociation",
  APIGATEWAYV2_INTEGRATION: "AWS::ApiGatewayV2::Integration",
  APIGATEWAYV2_ROUTE: "AWS::ApiGatewayV2::Route",
  APIGATEWAYV2_STAGE: "AWS::ApiGatewayV2::Stage",
  LAMBDA_PERMISSION: "AWS::Lambda::Permission",
} as const;

// ── Listing-Only Resource Types ─────────────────────────────────────────────
// Resource types used only for ARN-to-type mapping in listing/resolve commands.
// Not independently provisioned via Cloud Control API.

/** Named constants for resource types that appear only in listing/resolve operations. */
export const LIST_RESOURCE_TYPES = {
  CLOUDFORMATION_STACK: "AWS::CloudFormation::Stack",
  EVENTS_RULE: "AWS::Events::Rule",
  CLOUDFRONT_DISTRIBUTION: "AWS::CloudFront::Distribution",
  EKS_CLUSTER: "AWS::EKS::Cluster",
  ELASTICACHE_CACHE_CLUSTER: "AWS::ElastiCache::CacheCluster",
  KINESIS_STREAM: "AWS::Kinesis::Stream",
  STEPFUNCTIONS_STATE_MACHINE: "AWS::StepFunctions::StateMachine",
  IAM_MANAGED_POLICY: "AWS::IAM::ManagedPolicy",
  IAM_USER: "AWS::IAM::User",
  IAM_GROUP: "AWS::IAM::Group",
  IAM_INSTANCE_PROFILE: "AWS::IAM::InstanceProfile",
  APIGATEWAY_REST_API: "AWS::ApiGateway::RestApi",
  ELBV2_TARGET_GROUP: "AWS::ElasticLoadBalancingV2::TargetGroup",
  RDS_DB_CLUSTER: "AWS::RDS::DBCluster",
} as const;

/** Union of all CCAPI fallback resource type strings. */
export type CcapiFallbackType =
  (typeof CCAPI_FALLBACK_TYPES)[keyof typeof CCAPI_FALLBACK_TYPES];

/** Resource types that can be handled via direct AWS SDK calls (not CCAPI). */
export const CCAPI_SDK_ROUTABLE_TYPES: readonly string[] = [
  CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING,
  CCAPI_FALLBACK_TYPES.SNS_SUBSCRIPTION,
] as const;

/**
 * Resource types that are not supported and should redirect to an alternative.
 * Key: unsupported resource type, Value: recommended alternative type.
 */
export const CCAPI_REDIRECT_TYPES: Readonly<Record<string, string>> = {
  [CCAPI_FALLBACK_TYPES.LAMBDA_PERMISSION]: "AWS::Lambda::PermissionPolicy",
  [CCAPI_FALLBACK_TYPES.ELASTICACHE_REPLICATION_GROUP]:
    "AWS::ElastiCache::ServerlessCache",
} as const;
