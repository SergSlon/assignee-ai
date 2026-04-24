/**
 * Per-resource-type ARN synthesis templates consumed by
 * `buildResourceArn`. Replaces the 35-case switch that previously
 * lived inline in `arn-builder.ts` — adding a new type now requires a
 * single registry entry.
 *
 * Each template is a function that takes a `TemplateContext`
 * (partition, region, accountId, identifier) and returns either:
 *   - the synthesized ARN string, or
 *   - the original identifier unchanged (for types whose CCAPI
 *     primaryIdentifier is not an ARN-addressable resource — e.g.
 *     `AWS::EC2::Route`, `AWS::S3::BucketPolicy`).
 *
 * The `ExpectArnError` sentinel is used for resource types where
 * CloudControl is documented to always return the full ARN
 * (ELBv2 LoadBalancer, SNS Topic); the `isArn()` short-circuit in
 * `buildResourceArn` catches the happy path, so reaching a template
 * function for these types means CCAPI's response shape changed and
 * we should fail loudly rather than fabricate a malformed ARN.
 *
 * @see Story 49.4 (Epic 49) — table-drive buildResourceArn
 */

import { RESOURCE_TYPES } from "./resource-types.js";

/** Runtime context passed into every template function. */
export interface ArnTemplateContext {
  partition: string;
  region: string;
  accountId: string;
  identifier: string;
}

/**
 * Template function — returns the synthesized ARN string, OR the
 * bare identifier unchanged for non-ARN-addressable types. Throwing
 * from inside the template is reserved for CCAPI-shape regressions.
 */
export type ArnTemplate = (ctx: ArnTemplateContext) => string;

/** Error thrown when a type expected CCAPI to return a full ARN but got a bare identifier. */
export class ExpectedArnIdentifierError extends Error {
  constructor(resourceType: string, identifier: string) {
    super(
      `buildResourceArn: ${resourceType} expected a full ARN as identifier ` +
        `but got "${identifier}". CloudControl's response shape may have ` +
        `changed for this type. Update arn-templates.ts to synthesize the ARN ` +
        `from bare identifier components, or check the CloudControl client version.`,
    );
    this.name = "ExpectedArnIdentifierError";
  }
}

/**
 * Registry of ARN templates keyed by CloudFormation resource type.
 * Any type not present falls through to the `unknown` default in
 * `buildResourceArn` (returns identifier unchanged).
 */
export const arnTemplateRegistry: Record<string, ArnTemplate> = {
  // ── Global service (no region, no account) ────────────────────
  [RESOURCE_TYPES.S3_BUCKET]: ({ partition, identifier }) =>
    `arn:${partition}:s3:::${identifier}`,

  // ── Global service (no region, has account) ───────────────────
  [RESOURCE_TYPES.IAM_ROLE]: ({ partition, accountId, identifier }) =>
    `arn:${partition}:iam::${accountId}:role/${identifier}`,

  // ── Regional services with colon-separated identifier ─────────
  [RESOURCE_TYPES.LAMBDA_FUNCTION]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => `arn:${partition}:lambda:${region}:${accountId}:function:${identifier}`,
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => `arn:${partition}:rds:${region}:${accountId}:db:${identifier}`,
  [RESOURCE_TYPES.SECRETSMANAGER_SECRET]: ({
    partition,
    region,
    accountId,
    identifier,
  }) =>
    `arn:${partition}:secretsmanager:${region}:${accountId}:secret:${identifier}`,
  [RESOURCE_TYPES.CLOUDWATCH_ALARM]: ({
    partition,
    region,
    accountId,
    identifier,
  }) =>
    `arn:${partition}:cloudwatch:${region}:${accountId}:alarm:${identifier}`,
  [RESOURCE_TYPES.LOGS_LOG_GROUP]: ({
    partition,
    region,
    accountId,
    identifier,
  }) =>
    // Log group names canonically start with "/"; CloudControl returns
    // them with the leading slash preserved. The ARN uses ":" after the
    // service segment, not "/", so concatenate directly.
    `arn:${partition}:logs:${region}:${accountId}:log-group:${identifier}`,

  // ── Regional services with slash-separated identifier ─────────
  [RESOURCE_TYPES.DYNAMODB_TABLE]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => `arn:${partition}:dynamodb:${region}:${accountId}:table/${identifier}`,
  [RESOURCE_TYPES.EC2_INSTANCE]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => `arn:${partition}:ec2:${region}:${accountId}:instance/${identifier}`,
  [RESOURCE_TYPES.EC2_VPC]: ({ partition, region, accountId, identifier }) =>
    `arn:${partition}:ec2:${region}:${accountId}:vpc/${identifier}`,
  [RESOURCE_TYPES.EC2_SUBNET]: ({ partition, region, accountId, identifier }) =>
    `arn:${partition}:ec2:${region}:${accountId}:subnet/${identifier}`,
  [RESOURCE_TYPES.EC2_SECURITY_GROUP]: ({
    partition,
    region,
    accountId,
    identifier,
  }) =>
    `arn:${partition}:ec2:${region}:${accountId}:security-group/${identifier}`,
  [RESOURCE_TYPES.EC2_INTERNET_GATEWAY]: ({
    partition,
    region,
    accountId,
    identifier,
  }) =>
    `arn:${partition}:ec2:${region}:${accountId}:internet-gateway/${identifier}`,
  [RESOURCE_TYPES.EC2_ROUTE_TABLE]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => `arn:${partition}:ec2:${region}:${accountId}:route-table/${identifier}`,
  [RESOURCE_TYPES.EC2_NAT_GATEWAY]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => `arn:${partition}:ec2:${region}:${accountId}:natgateway/${identifier}`,
  // BUG-5 hotfix (DEMO-CRITICAL): EIP CCAPI primaryIdentifier is the
  // composite `<PublicIp>|<AllocationId>` (e.g. `34.193.143.180|eipalloc-0a4...`).
  // Without this template the apply-envelope returned the composite as
  // the addressable identifier, but destroy expected a real ARN OR
  // bare AllocationId, so apply→destroy round-trip leaked EIPs (~$3.60/mo
  // each). Strip the public-IP prefix, keep the AllocationId, synthesize
  // the canonical EIP ARN. Bare-AllocationId callers (no `|`) pass
  // through unchanged into the same ARN format.
  [RESOURCE_TYPES.EC2_EIP]: ({ partition, region, accountId, identifier }) => {
    // Composite shape `<PublicIp>|<AllocationId>` → take the right
    // segment. CCAPI is documented to use this composite for EIP.
    const allocationId = identifier.includes("|")
      ? identifier.split("|")[1]!
      : identifier;
    return `arn:${partition}:ec2:${region}:${accountId}:elastic-ip/${allocationId}`;
  },
  [RESOURCE_TYPES.ECR_REPOSITORY]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => `arn:${partition}:ecr:${region}:${accountId}:repository/${identifier}`,
  [RESOURCE_TYPES.ECS_CLUSTER]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => `arn:${partition}:ecs:${region}:${accountId}:cluster/${identifier}`,

  // ── API Gateway — region-scoped but no account segment ────────
  [RESOURCE_TYPES.APIGATEWAYV2_API]: ({ partition, region, identifier }) =>
    `arn:${partition}:apigateway:${region}::/apis/${identifier}`,

  // ── CloudFront (global service, account-scoped ARN) ───────────
  // No region segment. CCAPI returns the distribution ID (e.g.
  // "E1234567890ABC"); we synthesize the account-scoped ARN so
  // compound patterns can reference it in S3 BucketPolicy etc.
  [RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION]: ({
    partition,
    accountId,
    identifier,
  }) => `arn:${partition}:cloudfront::${accountId}:distribution/${identifier}`,

  // ── RDS DBSubnetGroup — CCAPI identifier is the group name.
  [RESOURCE_TYPES.RDS_DB_SUBNET_GROUP]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => `arn:${partition}:rds:${region}:${accountId}:subgrp:${identifier}`,

  // ── SQS queue — CloudControl identifier is the queue URL; parse
  //    the URL back into an ARN when possible.
  [RESOURCE_TYPES.SQS_QUEUE]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => {
    const match = identifier.match(
      /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d+)\/([^/]+)$/,
    );
    if (match) {
      const [, qRegion, qAccount, qName] = match;
      return `arn:${partition}:sqs:${qRegion}:${qAccount}:${qName}`;
    }
    return `arn:${partition}:sqs:${region}:${accountId}:${identifier}`;
  },

  // ── SSM Parameter — canonical names start with "/"; the ARN
  //    format attaches the leading slash to "parameter", not to
  //    the name.
  [RESOURCE_TYPES.SSM_PARAMETER]: ({
    partition,
    region,
    accountId,
    identifier,
  }) => {
    const name = identifier.startsWith("/") ? identifier.slice(1) : identifier;
    return `arn:${partition}:ssm:${region}:${accountId}:parameter/${name}`;
  },

  // ── Types that always return a full ARN from CCAPI — the
  //    `isArn()` short-circuit in buildResourceArn normally catches
  //    these. Reaching this template means CCAPI's response shape
  //    changed; fail loudly.
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: ({ identifier }) => {
    throw new ExpectedArnIdentifierError(
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      identifier,
    );
  },
  [RESOURCE_TYPES.SNS_TOPIC]: ({ identifier }) => {
    throw new ExpectedArnIdentifierError(RESOURCE_TYPES.SNS_TOPIC, identifier);
  },

  // ── Route & cross-reference types without standalone ARNs ────
  //    These are CloudFormation-only or EC2 properties, not
  //    first-class ARN-addressable resources. Return identifier
  //    unchanged so display paths still show something rather than
  //    failing loudly.
  [RESOURCE_TYPES.EC2_ROUTE]: ({ identifier }) => identifier,
  [RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT]: ({ identifier }) => identifier,
  [RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION]: ({ identifier }) =>
    identifier,
  // CloudFront OriginAccessControl has an ARN format, but CloudFront
  // itself only references it by Id in DistributionConfig.Origins[].
  // OriginAccessControlId — no downstream consumer needs the full
  // ARN. Return the bare Id so compound marker resolution drops it
  // straight into the origin config.
  [RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL]: ({ identifier }) =>
    identifier,
  // S3 BucketPolicy has no ARN per se — the CCAPI primaryIdentifier
  // is the bucket name itself (the policy IS the bucket's policy
  // attribute).
  [RESOURCE_TYPES.S3_BUCKET_POLICY]: ({ identifier }) => identifier,
};
