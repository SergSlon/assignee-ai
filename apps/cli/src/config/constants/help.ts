/**
 * Long-form help text blocks shown in `assignee --help` and error
 * messages. Domain sub-module of the former `config/constants.ts`
 * coupling hub (Story 49.5).
 *
 * **Source of truth.** The counts embedded in these hints are computed
 * from the canonical registries at module load:
 *   - `SUPPORTED_TYPES_ARRAY.length` for the resource-type count.
 *   - `defaultPatternRegistry.size()` for the compound-pattern count.
 * The accompanying bullet lists are maintained by hand because they
 * group types by user-facing domain (Compute / Networking / …) rather
 * than CFN namespace, but a CLI test asserts that every entry in
 * `SUPPORTED_TYPES_ARRAY` is covered by the textual enumeration so the
 * two cannot drift silently. See story 53-it1-05.
 */

import { SUPPORTED_TYPES_ARRAY, defaultPatternRegistry } from "@assignee/core";

/** Human-readable hint shown when an unsupported resource type is requested.
 *  Groups types by domain for scannability instead of dumping CFN type names.
 *  Every entry in SUPPORTED_TYPES_ARRAY is represented below. */
export const SUPPORTED_TYPES_HINT = `What you can create (${SUPPORTED_TYPES_ARRAY.length} resource types):

  Compute       EC2 instance, Lambda function, ECS cluster
  Storage       S3 bucket, S3 bucket policy, EFS file system,
                EFS mount target
  Databases     RDS DB instance (PostgreSQL/MySQL/MariaDB/Aurora),
                RDS DB subnet group, DynamoDB table
  Networking    VPC, Subnet, Security Group, Internet Gateway,
                VPC Gateway Attachment, Route Table, Route,
                Subnet ↔ Route Table Association, NAT Gateway,
                Load Balancer
  Edge / CDN    CloudFront distribution, CloudFront OAC
  API           API Gateway v2 (HTTP / WebSocket)
  Messaging     SQS queue, SNS topic, SNS subscription,
                EventBridge rule, EventBridge event bus,
                EventBridge connection, EventBridge API destination
  Security      IAM role, KMS key, Secrets Manager secret,
                SSM parameter
  Containers    ECR repository
  Observability CloudWatch alarm, CloudWatch Logs group

Examples:
  assignee plan "Create an S3 bucket for my static site"
  assignee plan "Create an EC2 t3.micro with SSH"
  assignee plan "Create a PostgreSQL database for production"`;

/** Architecture patterns hint shown in help text.
 *  Listed in registration (= keyword-match precedence) order to mirror
 *  the runtime registry. Count is computed from defaultPatternRegistry
 *  so adding/removing a pattern in core automatically updates the hint. */
export const PATTERNS_HINT = `Architecture patterns (${defaultPatternRegistry.size()} compound, first keyword match wins):
  "Create a serverless API"                    → Lambda + API Gateway v2 + IAM Role + LogGroup (8 resources)
  "Create a three-tier web app"                → VPC + public/private subnets + ALB + EC2 + RDS + SecurityGroups
  "Create a container service"                 → VPC + ALB + ECS Cluster + ECR + IAM Role (15 resources)
  "Create a message processing pipeline"       → SQS main + DLQ + Lambda + IAM Role + DynamoDB
  "Create a static website"                    → S3 Bucket + CloudFront + OAC + Bucket Policy
  "Create an EFS file system"                  → Private VPC + NFS SG + EFS + Mount Targets (9 resources)
  "Create a VPC with public/private subnets"   → VPC + Subnets + IGW + NAT + Routes (17 resources)
  "Create a VPC with public subnets only"      → VPC + public Subnets + IGW + Routes (free-tier)
  "Create a scheduled Lambda"                  → IAM Role + Lambda + EventBridge Rule + Permission (4 resources)
  "Create a Lambda function"                   → IAM Role + Lambda (2 resources, auto-created exec role)`;

/** Examples hint shown in help text. */
export const EXAMPLES_HINT = `Examples:
  assignee plan "Create an S3 bucket"             Plan a single resource
  assignee plan "Create a serverless API"          Plan a multi-resource architecture
  assignee apply "Create a Lambda function"        Plan and deploy in one step
  assignee drift                                   Check all resources for drift`;
