/**
 * Supported-types grouped block — single source of truth for the
 * "What you can create (N resource types): …" CLI grid.
 *
 * Extracted from `help-hints.ts` (Epic 92 wave 3.a, story e92-3a) so the
 * block has a dedicated module and `help-hints.ts` stays focused on the
 * umbrella API. The grouped rendering is kept by hand because the
 * user-facing categorisation (Compute / Networking / …) is not
 * derivable from the raw `AWS::Service::Type` CFN string — a drift-guard
 * test in `help-hints.test.ts` asserts that every
 * `SUPPORTED_TYPES_ARRAY` entry is mentioned somewhere in the rendered
 * string so the grouping can't silently fall behind the registry.
 *
 * Pure module — no SDK, filesystem, or runtime dependencies.
 */

import { SUPPORTED_TYPES_ARRAY } from "./resource-types/supported.js";

/** Max columns permitted in any rendered hint line (L2-001 closure). */
export const HINT_MAX_COLUMNS = 100 as const;

/**
 * Render the CLI-style grouped supported-types block. Grouped by
 * user-facing domain rather than raw CFN namespace. The count is
 * derived from `SUPPORTED_TYPES_ARRAY.length` at render time — adding a
 * supported type automatically bumps the header count (and the
 * drift-guard test catches any missing alias in the body).
 */
export function buildSupportedTypesBlock(): string {
  const count = SUPPORTED_TYPES_ARRAY.length;
  return `What you can create (${count} resource types):

  Compute       EC2 instance, Lambda function, ECS cluster
  Storage       S3 bucket, S3 bucket policy, EFS file system,
                EFS mount target
  Databases     RDS DB instance (PostgreSQL/MySQL/MariaDB/Aurora),
                RDS DB subnet group, DynamoDB table
  Networking    VPC, Subnet, Security Group, Internet Gateway,
                VPC Gateway Attachment, Route Table, Route,
                Subnet <-> Route Table Association, NAT Gateway,
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
}

/**
 * Short, single-line hint for error-path [FIX] text. Never the full
 * grouped block — error triples ([ERROR]+[CONTEXT]+[FIX]) must stay
 * compact so short terminals don't scroll the error out of sight (see
 * Epic 92 dogfood finding D-33). Callers that want the full block
 * should use `buildSupportedTypesBlock()` and only on `--help` output.
 */
export function getTypeHint(): string {
  return "Run `assignee plan --help` for the list of supported resource types and architecture patterns.";
}
