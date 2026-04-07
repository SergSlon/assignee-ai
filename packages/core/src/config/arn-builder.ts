/**
 * ARN builder — constructs a full AWS ARN from a CloudControl resource
 * type + primary identifier + account/region context.
 *
 * CloudControl's `GetResourceRequestStatus.ProgressEvent.Identifier`
 * returns the resource's PRIMARY identifier, which for most types is
 * the bare name (BucketName, RoleName, FunctionName, TableName, etc.)
 * — NOT the ARN. `assignee apply`'s success output previously displayed
 * this bare identifier in the `ARN:` field, which is misleading for
 * scripting (users can't pipe it back to `assignee destroy <arn>`).
 *
 * This helper centralizes the per-type ARN synthesis so every display
 * path produces consistent, copy-pasteable ARNs. It does NOT do network
 * I/O — callers are responsible for supplying accountId and region.
 *
 * @see Phase 2 smoke test BUG-5
 */

import { RESOURCE_TYPES } from "./resource-types.js";

/**
 * AWS partition detected from the region. Callers usually pass the
 * operator's region and let this helper pick the right partition so
 * GovCloud and China deployments produce valid ARNs.
 */
export function partitionForRegion(region: string): string {
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("cn-")) return "aws-cn";
  return "aws";
}

/**
 * Args for buildResourceArn. All fields are required except partition
 * (defaulted from region). identifier must be the CloudControl primary
 * identifier as returned by GetResourceRequestStatus — NOT the ARN.
 */
export interface BuildResourceArnArgs {
  resourceType: string;
  identifier: string;
  region: string;
  accountId: string;
  partition?: string;
}

/**
 * Returns true if the given string already looks like a full AWS ARN.
 * Used as a short-circuit in display paths: if CloudControl happened
 * to return an ARN (some types do — ELBv2 LoadBalancer, ECS Cluster),
 * we don't re-synthesize.
 */
export function isArn(value: string): boolean {
  return /^arn:aws[\w-]*:/.test(value);
}

/**
 * Builds the canonical ARN for a supported CloudFormation resource
 * type, given its primary identifier. Returns the input identifier
 * unchanged when:
 *   - it already looks like an ARN (isArn check)
 *   - the resource type is unknown or has no stable ARN format
 *
 * The per-type branches mirror AWS's own ARN formats documented in
 * the IAM policy reference. When adding support for a new resource
 * type, add both the RESOURCE_TYPES constant AND the ARN format here.
 *
 * Tests in arn-builder.test.ts cover every type in RESOURCE_TYPES.
 */
export function buildResourceArn(args: BuildResourceArnArgs): string {
  const { resourceType, identifier, region, accountId } = args;
  const partition = args.partition ?? partitionForRegion(region);

  // Already an ARN — preserve it verbatim. CloudControl returns full
  // ARNs for a few types (ELBv2 LoadBalancer, ECS Cluster, SNS Topic).
  if (isArn(identifier)) return identifier;

  switch (resourceType) {
    // ── Global service (no region, no account) ────────────────────
    case RESOURCE_TYPES.S3_BUCKET:
      return `arn:${partition}:s3:::${identifier}`;

    // ── Global service (no region, has account) ───────────────────
    case RESOURCE_TYPES.IAM_ROLE:
      return `arn:${partition}:iam::${accountId}:role/${identifier}`;

    // ── Regional services with colon-separated identifier ─────────
    case RESOURCE_TYPES.LAMBDA_FUNCTION:
      return `arn:${partition}:lambda:${region}:${accountId}:function:${identifier}`;
    case RESOURCE_TYPES.RDS_DB_INSTANCE:
      return `arn:${partition}:rds:${region}:${accountId}:db:${identifier}`;
    case RESOURCE_TYPES.SECRETSMANAGER_SECRET:
      return `arn:${partition}:secretsmanager:${region}:${accountId}:secret:${identifier}`;
    case RESOURCE_TYPES.CLOUDWATCH_ALARM:
      return `arn:${partition}:cloudwatch:${region}:${accountId}:alarm:${identifier}`;
    case RESOURCE_TYPES.LOGS_LOG_GROUP: {
      // Log group names canonically start with "/"; CloudControl returns
      // them with the leading slash preserved. The ARN format uses ":"
      // after the service segment, not "/", so concatenate directly.
      return `arn:${partition}:logs:${region}:${accountId}:log-group:${identifier}`;
    }

    // ── Regional services with slash-separated identifier ─────────
    case RESOURCE_TYPES.DYNAMODB_TABLE:
      return `arn:${partition}:dynamodb:${region}:${accountId}:table/${identifier}`;
    case RESOURCE_TYPES.EC2_INSTANCE:
      return `arn:${partition}:ec2:${region}:${accountId}:instance/${identifier}`;
    case RESOURCE_TYPES.EC2_VPC:
      return `arn:${partition}:ec2:${region}:${accountId}:vpc/${identifier}`;
    case RESOURCE_TYPES.EC2_SUBNET:
      return `arn:${partition}:ec2:${region}:${accountId}:subnet/${identifier}`;
    case RESOURCE_TYPES.EC2_SECURITY_GROUP:
      return `arn:${partition}:ec2:${region}:${accountId}:security-group/${identifier}`;
    case RESOURCE_TYPES.EC2_INTERNET_GATEWAY:
      return `arn:${partition}:ec2:${region}:${accountId}:internet-gateway/${identifier}`;
    case RESOURCE_TYPES.EC2_ROUTE_TABLE:
      return `arn:${partition}:ec2:${region}:${accountId}:route-table/${identifier}`;
    case RESOURCE_TYPES.EC2_NAT_GATEWAY:
      return `arn:${partition}:ec2:${region}:${accountId}:natgateway/${identifier}`;
    case RESOURCE_TYPES.ECR_REPOSITORY:
      return `arn:${partition}:ecr:${region}:${accountId}:repository/${identifier}`;
    case RESOURCE_TYPES.APIGATEWAYV2_API:
      return `arn:${partition}:apigateway:${region}::/apis/${identifier}`;

    // ── Regional services where CloudControl returns a full ARN ──
    // These short-circuit via the isArn() check above. Listed here
    // so the switch is exhaustive over RESOURCE_TYPES and adding a
    // new type that CCAPI-identifies-by-ARN won't silently fall
    // through to the default bare-identifier return.
    //
    // Wave 11 P2-5: if we reach this branch with a non-ARN identifier,
    // CCAPI's response shape has changed — historically these types
    // always return a full ARN as the primary identifier. Throwing is
    // the right response: silently passing a bare identifier downstream
    // would corrupt billing MCP records and break `assignee destroy
    // <identifier>` because the bare value isn't a valid CloudControl
    // identifier for these types either. Better to fail loudly here
    // than to leak a malformed ARN into provision logs and the user-
    // visible apply success line.
    case RESOURCE_TYPES.ELBV2_LOAD_BALANCER:
    case RESOURCE_TYPES.ECS_CLUSTER:
    case RESOURCE_TYPES.SNS_TOPIC:
      throw new Error(
        `buildResourceArn: ${resourceType} expected a full ARN as identifier ` +
          `but got "${identifier}". CloudControl's response shape may have ` +
          `changed for this type. Update arn-builder.ts to synthesize the ARN ` +
          `from bare identifier components, or check the CloudControl client ` +
          `version.`,
      );

    // ── SQS queue uses a special URL/ARN split ────────────────────
    // CloudControl identifier for SQS is the queue URL
    // (https://sqs.<region>.amazonaws.com/<account>/<name>). We parse
    // that back into an ARN.
    case RESOURCE_TYPES.SQS_QUEUE: {
      const match = identifier.match(
        /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d+)\/([^/]+)$/,
      );
      if (match) {
        const [, qRegion, qAccount, qName] = match;
        return `arn:${partition}:sqs:${qRegion}:${qAccount}:${qName}`;
      }
      return `arn:${partition}:sqs:${region}:${accountId}:${identifier}`;
    }

    // ── SSM Parameter — leading slash in identifier, colon in ARN ─
    case RESOURCE_TYPES.SSM_PARAMETER: {
      // Canonical parameter names start with "/". CloudControl returns
      // "/my/param" and the ARN is "...:parameter/my/param" (the "/"
      // attaches to "parameter", not to the name).
      const name = identifier.startsWith("/")
        ? identifier.slice(1)
        : identifier;
      return `arn:${partition}:ssm:${region}:${accountId}:parameter/${name}`;
    }

    // ── Route & cross-reference types without standalone ARNs ────
    // These are CloudFormation-only or EC2 properties, not first-class
    // ARN-addressable resources. Return the identifier unchanged and
    // let display paths show something rather than fail loudly.
    case RESOURCE_TYPES.EC2_ROUTE:
    case RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT:
    case RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION:
      return identifier;

    default:
      // Unknown resource type — return the bare identifier rather
      // than fabricate a wrong-shaped ARN. Callers that need a
      // strict check can use isArn() first.
      return identifier;
  }
}
