/**
 * Long-form help text blocks shown in `assignee --help` and error
 * messages. Domain sub-module of the former `config/constants.ts`
 * coupling hub (Story 49.5).
 */

import { SUPPORTED_TYPES_ARRAY } from "@assignee/core";

/** Human-readable hint shown when an unsupported resource type is requested.
 *  Groups types by domain for scannability instead of dumping CFN type names. */
export const SUPPORTED_TYPES_HINT = `What you can create (${SUPPORTED_TYPES_ARRAY.length} resource types):

  Compute       EC2 instance, Lambda function, ECS cluster
  Storage       S3 bucket
  Databases     RDS (PostgreSQL/MySQL/MariaDB/Aurora), DynamoDB table
  Networking    VPC, Subnet, Security Group, Internet Gateway,
                NAT Gateway, Route Table, Route, Load Balancer
  API           API Gateway v2 (HTTP/WebSocket)
  Messaging     SQS queue, SNS topic
  Security      IAM role, Secrets Manager secret, SSM parameter
  Containers    ECR repository
  Observability CloudWatch alarm, CloudWatch Logs group

Examples:
  assignee plan "Create an S3 bucket for my static site"
  assignee plan "Create an EC2 t3.micro with SSH"
  assignee plan "Create a PostgreSQL database for production"`;

/** Architecture patterns hint shown in help text. */
export const PATTERNS_HINT = `Architecture patterns (multi-resource):
  "Create a serverless API"                → Lambda + API Gateway + IAM Role + LogGroup
  "Create a three-tier web app"            → EC2 + RDS + SecurityGroup
  "Create a VPC with public/private subnets" → VPC + Subnets + IGW + NAT + Routes (17 resources)
  "Create a message processing pipeline"   → SQS + Lambda + DLQ
  "Create a container service"             → ECS Cluster + ECR + IAM Role
  "Create a static website"               → S3 Bucket (+ CloudFront)`;

/** Examples hint shown in help text. */
export const EXAMPLES_HINT = `Examples:
  assignee plan "Create an S3 bucket"             Plan a single resource
  assignee plan "Create a serverless API"          Plan a multi-resource architecture
  assignee apply "Create a Lambda function"        Plan and deploy in one step
  assignee drift                                   Check all resources for drift`;
