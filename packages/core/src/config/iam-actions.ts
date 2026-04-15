/**
 * Maps CloudFormation resource types to the IAM actions required
 * for CloudControl API provisioning + service-specific bootstrapping.
 *
 * This file is now a pure barrel re-export. Implementation lives under
 * `./iam-actions/` split per AWS service family:
 *   - `ccapi.ts`          — base CloudControl API actions (all resource types)
 *   - `s3.ts`             — S3 Bucket + BucketPolicy
 *   - `compute.ts`        — Lambda, EC2 Instance, ECS, ECR
 *   - `database.ts`       — DynamoDB, RDS
 *   - `network.ts`        — VPC, Subnet, SG, ELBv2, IGW, RT, Route, NATGW, APIGWv2
 *   - `security.ts`       — IAM Role, KMS, SecretsManager
 *   - `messaging.ts`      — SQS, SNS, EventBridge
 *   - `observability.ts`  — CloudWatch, Logs, SSM
 *   - `storage.ts`        — EFS, CloudFront
 *   - `service-map.ts`    — merged lookup composed from the shards above
 *
 * For unknown resource types, only the base CloudControl API actions are returned.
 * The mapping can be expanded incrementally as new resource types are added.
 *
 * @see Story 19.1 — IAM MCP Server Integration (FR-43)
 */

export * from "./iam-actions/index.js";
