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

/** Resource IDs for the Three-Tier Web pattern. */
export const ThreeTierWebResourceId = {
  ALB_SG: "alb-sg",
  APP_SG: "app-sg",
  INSTANCE_PROFILE_ROLE: "instance-profile-role",
  ALB: "alb",
  EC2_INSTANCE: "ec2-instance",
  RDS_INSTANCE: "rds-instance",
} as const;

/** Resource IDs for the Container Service pattern. */
export const ContainerServiceResourceId = {
  ECR_REPO: "ecr-repo",
  TASK_ROLE: "task-role",
  ECS_SG: "ecs-sg",
  ECS_CLUSTER: "ecs-cluster",
  ALB: "alb",
} as const;

/** Resource IDs for the Static Website pattern. */
export const StaticWebsiteResourceId = {
  WEBSITE_BUCKET: "website-bucket",
  CDN_DISTRIBUTION: "cdn-distribution",
  CDN_OAC: "cdn-oac",
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
