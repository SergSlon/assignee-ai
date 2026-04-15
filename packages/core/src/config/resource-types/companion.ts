/**
 * Companion + listing-only resource types.
 * - Companion: auto-provisioned alongside a primary resource.
 * - Listing-only: used only for ARN-to-type mapping in list/resolve commands.
 *
 * Split out of `resource-types.ts` for SRP / file-size compliance.
 */

// ── Companion Resource Types ────────────────────────────────────────────────

/** Named constants for companion-only resource types that are not independently provisioned. */
export const COMPANION_RESOURCE_TYPES = {
  EC2_EIP: "AWS::EC2::EIP",
  // EC2_VPC_GATEWAY_ATTACHMENT and EC2_SUBNET_ROUTE_TABLE_ASSOCIATION were
  // promoted to RESOURCE_TYPES in WV4-A (marker-token resolver landed in
  // plan-generator.ts) — they are now independently provisionable and
  // should be referenced via RESOURCE_TYPES instead.
  SECRETSMANAGER_SECRET_TARGET_ATTACHMENT:
    "AWS::SecretsManager::SecretTargetAttachment",
  APIGATEWAYV2_INTEGRATION: "AWS::ApiGatewayV2::Integration",
  APIGATEWAYV2_ROUTE: "AWS::ApiGatewayV2::Route",
  APIGATEWAYV2_STAGE: "AWS::ApiGatewayV2::Stage",
  LAMBDA_PERMISSION: "AWS::Lambda::Permission",
} as const;

// ── Listing-Only Resource Types ─────────────────────────────────────────────

/** Named constants for resource types that appear only in listing/resolve operations. */
export const LIST_RESOURCE_TYPES = {
  CLOUDFORMATION_STACK: "AWS::CloudFormation::Stack",
  // A8 (2026-04-08): EVENTS_RULE promoted to SUPPORTED_TYPES_ARRAY.
  // A14 (2026-04-09): CLOUDFRONT_DISTRIBUTION promoted to first-class.
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
  // A6 (2026-04-08): Lambda EventSourceMapping migrated out of CCAPI_FALLBACK_TYPES.
  LAMBDA_EVENT_SOURCE_MAPPING: "AWS::Lambda::EventSourceMapping",
} as const;
