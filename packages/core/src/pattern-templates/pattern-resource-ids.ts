/**
 * Canonical resource IDs used in architecture pattern templates.
 * Single source of truth — every resourceId string in a pattern must reference these constants.
 *
 * VPC-related resource IDs are defined in vpc-networking.ts as VpcResourceId.
 */

/** Resource IDs for the Serverless API pattern. */
export const ServerlessApiResourceId = {
  IAM_EXECUTION_ROLE: "iam-execution-role",
  LAMBDA_FN: "lambda-fn",
  ACCESS_LOG_GROUP: "access-log-group",
  HTTP_API: "http-api",
  LAMBDA_INTEGRATION: "lambda-integration",
  DEFAULT_ROUTE: "default-route",
  DEFAULT_STAGE: "default-stage",
  API_INVOKE_PERMISSION: "api-invoke-permission",
} as const;

/** Resource IDs for the Message Processing pattern. */
export const MessageProcessingResourceId = {
  DLQ: "dlq",
  MAIN_QUEUE: "main-queue",
  RESULTS_TABLE: "results-table",
  LAMBDA_ROLE: "lambda-role",
  PROCESSOR_FN: "processor-fn",
} as const;

/** Resource IDs for the Three-Tier Web pattern.
 * VPC resource IDs mirror VpcResourceId in vpc-networking.ts so the
 * compound-provisioner's marker resolution treats the patterns identically.
 * No NAT gateway — private subnets host only RDS (no internet needed).
 */
export const ThreeTierWebResourceId = {
  // VPC topology (public + private, no NAT)
  VPC: "vpc",
  PUBLIC_SUBNET_1: "public-subnet-1",
  PUBLIC_SUBNET_2: "public-subnet-2",
  PRIVATE_SUBNET_1: "private-subnet-1",
  PRIVATE_SUBNET_2: "private-subnet-2",
  IGW: "igw",
  IGW_ATTACHMENT: "igw-attachment",
  PUBLIC_ROUTE_TABLE: "public-route-table",
  PRIVATE_ROUTE_TABLE: "private-route-table",
  PUBLIC_ROUTE: "public-route",
  PUBLIC_SUBNET_1_RT_ASSOC: "public-subnet-1-rt-assoc",
  PUBLIC_SUBNET_2_RT_ASSOC: "public-subnet-2-rt-assoc",
  PRIVATE_SUBNET_1_RT_ASSOC: "private-subnet-1-rt-assoc",
  PRIVATE_SUBNET_2_RT_ASSOC: "private-subnet-2-rt-assoc",
  // Application layer
  ALB_SG: "alb-sg",
  APP_SG: "app-sg",
  DB_SG: "db-sg",
  INSTANCE_PROFILE_ROLE: "instance-profile-role",
  DB_SUBNET_GROUP: "db-subnet-group",
  ALB: "alb",
  EC2_INSTANCE: "ec2-instance",
  RDS_INSTANCE: "rds-instance",
} as const;

/** Resource IDs for the Container Service pattern.
 * VPC resource IDs mirror VpcResourceId in vpc-networking.ts so the
 * compound-provisioner's marker resolution treats both patterns identically.
 */
export const ContainerServiceResourceId = {
  // VPC topology (mirrors VpcResourceId — public-only variant)
  VPC: "vpc",
  PUBLIC_SUBNET_1: "public-subnet-1",
  PUBLIC_SUBNET_2: "public-subnet-2",
  IGW: "igw",
  IGW_ATTACHMENT: "igw-attachment",
  PUBLIC_ROUTE_TABLE: "public-route-table",
  PUBLIC_ROUTE: "public-route",
  PUBLIC_SUBNET_1_RT_ASSOC: "public-subnet-1-rt-assoc",
  PUBLIC_SUBNET_2_RT_ASSOC: "public-subnet-2-rt-assoc",
  // Container-service-specific
  ALB_SG: "alb-sg",
  ECR_REPO: "ecr-repo",
  TASK_ROLE: "task-role",
  ECS_SG: "ecs-sg",
  ECS_CLUSTER: "ecs-cluster",
  ALB: "alb",
} as const;

/** Resource IDs for the Static Website pattern. */
export const StaticWebsiteResourceId = {
  WEBSITE_BUCKET: "website-bucket",
  CDN_OAC: "cdn-oac",
  CDN_DISTRIBUTION: "cdn-distribution",
  // (f) 2026-04-09 Task 4b: explicit BucketPolicy resource that grants
  // CloudFront (via OAC) read access to the bucket, scoped to the
  // distribution's aws:SourceArn. Pre-migration this was applied via
  // a post-provision PutBucketPolicy SDK call in result-formatter.ts;
  // the migration rewires it as a compound resource with a marker-
  // resolved dependency on the distribution.
  BUCKET_POLICY: "bucket-policy",
} as const;

/**
 * Resource IDs for the Wave 13 Lambda + auto-created exec role pattern.
 * Mirrors `ServerlessApiResourceId.IAM_EXECUTION_ROLE` / `.LAMBDA_FN` so
 * the plan-generator's existing compound role-injection logic in
 * apps/cli/src/nodes/plan-generator.ts (the LAMBDA_FUNCTION + completed
 * IAM_ROLE branch around line 545) handles this pattern with zero
 * additional code paths. The two values are intentionally identical
 * to the serverless-api equivalents for that reason.
 */
export const LambdaWithExecRoleResourceId = {
  IAM_EXECUTION_ROLE: "iam-execution-role",
  LAMBDA_FN: "lambda-fn",
} as const;

/**
 * Resource IDs for the scheduled-lambda compound pattern.
 *
 * Mirrors `LambdaWithExecRoleResourceId` for the IAM+Lambda pair so
 * plan-generator's existing compound role-injection branch handles
 * both patterns with zero additional code. The EventBridge rule and
 * display-only Lambda Permission are unique to this pattern.
 */
export const ScheduledLambdaResourceId = {
  IAM_EXECUTION_ROLE: "iam-execution-role",
  LAMBDA_FN: "lambda-fn",
  SCHEDULE_RULE: "schedule-rule",
  INVOKE_PERMISSION: "invoke-permission",
} as const;

/**
 * Resource IDs for the WebSocket API compound pattern (Epic 92 wave 2.b).
 *
 * Mirrors `ServerlessApiResourceId` for the shared slots (IAM Role,
 * Lambda, LogGroup, API, Stage, Permission) so plan-generator's
 * existing compound role-injection and marker-resolution code paths
 * handle both patterns identically. The difference is the Route /
 * Integration fan-out: WebSocket APIs have three canonical routes
 * ($connect, $disconnect, $default), each wired to its own
 * Integration record pointing at the same Lambda.
 *
 * Per API Gateway v2 docs:
 * https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/apis-apiid-routes.html
 */
export const WebsocketApiResourceId = {
  IAM_EXECUTION_ROLE: "iam-execution-role",
  LAMBDA_FN: "lambda-fn",
  ACCESS_LOG_GROUP: "access-log-group",
  WEBSOCKET_API: "websocket-api",
  CONNECT_INTEGRATION: "connect-integration",
  DISCONNECT_INTEGRATION: "disconnect-integration",
  DEFAULT_INTEGRATION: "default-integration",
  CONNECT_ROUTE: "connect-route",
  DISCONNECT_ROUTE: "disconnect-route",
  DEFAULT_ROUTE: "default-route",
  DEFAULT_STAGE: "default-stage",
  API_INVOKE_PERMISSION: "api-invoke-permission",
} as const;

/**
 * Resource IDs for the SQS-with-DLQ compound pattern.
 *
 * DLQ is provisioned first so its ARN can be wired into the primary
 * queue's RedrivePolicy.deadLetterTargetArn via markerGetAtt.
 */
export const SqsWithDlqResourceId = {
  DLQ: "dlq",
  PRIMARY_QUEUE: "primary-queue",
} as const;

/**
 * Resource IDs for the EFS-with-VPC compound pattern.
 *
 * The VPC-bearing resource IDs intentionally reuse the same string
 * values as `VpcResourceId` in vpc-networking.ts so the two patterns
 * are consistent and the compound-provisioner's ref resolution walks
 * the same resourceId namespace. The NFS security group and mount
 * targets are unique to this pattern.
 */
export const EfsWithVpcResourceId = {
  // VPC topology (mirrors VpcResourceId)
  VPC: "vpc",
  PRIVATE_SUBNET_1: "private-subnet-1",
  PRIVATE_SUBNET_2: "private-subnet-2",
  PRIVATE_ROUTE_TABLE: "private-route-table",
  PRIVATE_SUBNET_1_RT_ASSOC: "private-subnet-1-rt-assoc",
  PRIVATE_SUBNET_2_RT_ASSOC: "private-subnet-2-rt-assoc",
  // EFS-specific
  NFS_SG: "nfs-sg",
  EFS_FILE_SYSTEM: "efs-file-system",
  MOUNT_TARGET_1: "mount-target-1",
  MOUNT_TARGET_2: "mount-target-2",
} as const;
