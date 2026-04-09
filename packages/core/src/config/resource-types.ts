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
  // A1 (2026-04-08): first-class EFS support for stateful Lambda /
  // ECS shared volumes. Full plugin, pricing decomposer, BP rules
  // (BP-EFS-001 encryption, BP-EFS-002 backup). CCAPI schema verified
  // to support create/delete/update handlers.
  "AWS::EFS::FileSystem",
  // A1 follow-up (2026-04-08): EFS MountTarget — attaches an EFS
  // file system to a subnet + security group so EC2/Lambda/ECS
  // workloads can actually mount it. CCAPI schema probed: required
  // fields FileSystemId + SecurityGroups + SubnetId, primary id
  // /properties/Id, create/delete handlers present.
  "AWS::EFS::MountTarget",
  // A8 (2026-04-08): AWS::Events::Rule promoted from LIST_RESOURCE_TYPES
  // to first-class support. CCAPI schema probed on 2026-04-08 —
  // primaryIdentifier /properties/Arn (readOnly), createOnly [Name],
  // no required fields at schema level (but logically either
  // EventPattern or ScheduleExpression plus at least one Target
  // are needed). Unblocks event-driven Lambda patterns and the
  // future scheduled-lambda compound.
  "AWS::Events::Rule",
  // A9 (2026-04-09): AWS::Events::EventBus first-class support.
  // First service added after the operator-policy split that
  // restored 4581/1616 bytes of headroom on the core/services
  // policies. CCAPI schema probed on 2026-04-09 — primaryIdentifier
  // /properties/Name (createOnly + required), readOnly /properties/Arn,
  // optional KmsKeyIdentifier + Policy + DeadLetterConfig + LogConfig.
  // Unblocks cross-account / SaaS-partner event ingestion patterns.
  "AWS::Events::EventBus",
  // A10 (2026-04-09): AWS::SNS::Subscription promoted out of
  // CCAPI_FALLBACK_TYPES to first-class. CCAPI schema probed
  // 2026-04-09 — all five handlers (create/read/update/delete/list)
  // present. Required: TopicArn + Protocol. createOnly: TopicArn,
  // Protocol, Endpoint. primaryIdentifier + readOnly: /properties/Arn.
  // NOT taggable (tagging.taggable=false) — listed in NO_TAG_TYPES
  // in apps/cli/src/utils/tags.ts so injectMandatoryTags skips it.
  // Promoting retires sdk-fallback-dispatcher subscribe/unsubscribe
  // code paths and frees ~50 bytes from sdkFallbackActions.
  "AWS::SNS::Subscription",
  // A11 (2026-04-09): AWS::KMS::Key first-class. Lights up
  // customer-managed-key targets for BP-EFS-001, BP-S3-001,
  // BP-RDS-* and every other "use a CMK instead of the AWS-managed
  // key" advisory. CCAPI schema probed 2026-04-09: all five handlers
  // present, primaryIdentifier /properties/KeyId (auto-generated,
  // readOnly), taggable on create + update, no schema-required
  // fields. Supports symmetric encryption keys (default
  // SYMMETRIC_DEFAULT), asymmetric signing/encrypting keys via
  // KeySpec, and MultiRegion=true for cross-region replication.
  // Scope for this slice: symmetric customer-managed keys — the
  // common case. Custom key stores (Origin=AWS_CLOUDHSM) and
  // external material (Origin=EXTERNAL) are callable from the
  // generic plugin if a user asks, but are not wizard-promoted.
  "AWS::KMS::Key",
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
  // A1 (2026-04-08)
  EFS_FILE_SYSTEM: "AWS::EFS::FileSystem",
  EFS_MOUNT_TARGET: "AWS::EFS::MountTarget",
  // A8 (2026-04-08) — EventBridge Rule first-class
  EVENTS_RULE: "AWS::Events::Rule",
  // A9 (2026-04-09) — EventBridge custom event bus first-class
  EVENTS_EVENT_BUS: "AWS::Events::EventBus",
  // A10 (2026-04-09) — SNS Subscription promoted from CCAPI_FALLBACK_TYPES
  SNS_SUBSCRIPTION: "AWS::SNS::Subscription",
  // A11 (2026-04-09) — KMS::Key first-class (symmetric CMK common case)
  KMS_KEY: "AWS::KMS::Key",
} as const satisfies Record<string, ResourceType>;

/** Ordered array of all resource types supported in the POC phase. */
export const SUPPORTED_POC_TYPES: ResourceType[] = [...SUPPORTED_TYPES_ARRAY];

// ── CCAPI Fallback Types (Story 7.7; narrowed by A6 and A10) ────────────────
// Resource types that cannot be provisioned via Cloud Control API.
// After A10 these are redirect-only types — there is no remaining
// SDK-based create/delete path in this codebase, only friendly
// redirect messages pointing at the supported alternative.
//
// A6  (2026-04-08) removed AWS::Lambda::EventSourceMapping from this set
//                  after verifying CCAPI has full Create/Delete/Update
//                  handlers. The type is still referenced from
//                  LIST_RESOURCE_TYPES for ARN-to-type resolution on
//                  destroy.
// A10 (2026-04-09) removed AWS::SNS::Subscription after the CCAPI
//                  schema probe confirmed all five handlers
//                  (create/read/update/delete/list). The SDK
//                  SubscribeCommand/UnsubscribeCommand code paths in
//                  sdk-fallback-dispatcher.ts were deleted. The only
//                  remaining entries are pure redirect types with no
//                  SDK write-path in this codebase.

/** All resource types known to have CCAPI gaps. */
export const CCAPI_FALLBACK_TYPES = {
  LAMBDA_PERMISSION: "AWS::Lambda::Permission",
  ELASTICACHE_REPLICATION_GROUP: "AWS::ElastiCache::ReplicationGroup",
} as const;

// ── Companion Resource Types ────────────────────────────────────────────────
// Resource types used only as companions (auto-provisioned alongside a primary resource).

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
// Resource types used only for ARN-to-type mapping in listing/resolve commands.
// Not independently provisioned via Cloud Control API.

/** Named constants for resource types that appear only in listing/resolve operations. */
export const LIST_RESOURCE_TYPES = {
  CLOUDFORMATION_STACK: "AWS::CloudFormation::Stack",
  // A8 (2026-04-08): EVENTS_RULE promoted to SUPPORTED_TYPES_ARRAY /
  // RESOURCE_TYPES — full plugin, pricing, IAM actions, BP rules.
  // Listing + destroy routes still work via the main registry.
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
  // A6 (2026-04-08): Lambda EventSourceMapping migrated out of CCAPI_FALLBACK_TYPES.
  // CCAPI fully supports create/delete/update for this type, but it has no
  // Assignee plan-generation path (no plugin, no compound pattern), so it only
  // shows up during destroy-by-ARN resolution.
  LAMBDA_EVENT_SOURCE_MAPPING: "AWS::Lambda::EventSourceMapping",
} as const;

/** Union of all CCAPI fallback resource type strings. */
export type CcapiFallbackType =
  (typeof CCAPI_FALLBACK_TYPES)[keyof typeof CCAPI_FALLBACK_TYPES];

/**
 * Resource types that can be handled via direct AWS SDK calls (not CCAPI).
 *
 * A10 (2026-04-09): emptied after SNS::Subscription was promoted to
 * first-class. The SDK dispatcher now only handles redirect-type
 * short-circuits (LAMBDA_PERMISSION, ELASTICACHE_REPLICATION_GROUP).
 * Kept as an empty readonly array so the dispatcher's canHandle() /
 * canDelete() hooks keep compiling — promoting a future SDK-only
 * type would re-populate this list.
 */
export const CCAPI_SDK_ROUTABLE_TYPES: readonly string[] = [] as const;

/**
 * Resource types that are not supported and should redirect to an alternative.
 * Key: unsupported resource type, Value: recommended alternative type.
 */
export const CCAPI_REDIRECT_TYPES: Readonly<Record<string, string>> = {
  [CCAPI_FALLBACK_TYPES.LAMBDA_PERMISSION]: "AWS::Lambda::PermissionPolicy",
  [CCAPI_FALLBACK_TYPES.ELASTICACHE_REPLICATION_GROUP]:
    "AWS::ElastiCache::ServerlessCache",
} as const;
