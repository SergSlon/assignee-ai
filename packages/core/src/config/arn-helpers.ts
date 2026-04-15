/**
 * ARN helpers — shared parsing utilities for ARN → resource-type,
 * ARN → identifier extraction, and CloudControl identifier resolution.
 *
 * Wave 3 P2-2 consolidation: previously duplicated in
 *   - `apps/cli/src/services/resource-resolver.ts`
 *   - `apps/mcp-server/src/tools/destroy-resource.ts`
 * with subtly different service maps. Both CLI and MCP server now
 * import from here so the map stays in sync across packages and
 * future services only need to be added once.
 *
 * Partition awareness: `isArn` uses the canonical `ARN_PATTERN` from
 * `aws-partition.ts`, which accepts all 5 published partitions
 * (`aws`, `aws-cn`, `aws-us-gov`, `aws-iso`, `aws-iso-b`). Never
 * hardcode `arn:aws:` literals — that silently drops GovCloud, China,
 * and ISO ARNs. @see feedback_partition_aware_arn_matching
 *
 * @see Wave 3 F8 — P2-2 ARN helper dedup
 */

import { SERVICE_TYPE_MAP, SERVICE_SUBTYPE_MAP } from "./arn-type-map.js";
import { RESOURCE_TYPES } from "./resource-types.js";

// `isArn` lives in `arn-builder.ts` and is re-exported from the package
// root. Callers who only need detection import from `@assignee/core`.

/**
 * Resolves an ARN to a known CloudFormation resource type.
 *
 * Returns `null` when the service/resource combination is not in the
 * catalog — callers that want a best-guess fallback should use
 * `arnToCloudFormationType` from `arn-type-map.ts` instead.
 *
 * @example
 *   arnToResourceType("arn:aws:s3:::my-bucket")              // "AWS::S3::Bucket"
 *   arnToResourceType("arn:aws:ec2:us-east-1:0:vpc/vpc-abc") // "AWS::EC2::VPC"
 *   arnToResourceType("arn:aws:unknown:::foo")               // null
 */
export function arnToResourceType(arn: string): string | null {
  const parts = arn.split(":");
  if (parts.length < 6) return null;
  const service = parts[2];
  const resourcePart = parts[5] ?? "";
  if (!service) return null;

  // Subtype map first (ec2, iam, apigateway, elasticloadbalancing, etc.)
  const subtypes = SERVICE_SUBTYPE_MAP[service];
  if (subtypes) {
    const segments = resourcePart.split(/[:/]/).filter(Boolean);
    const resourceSeg = segments[0] ?? "";
    if (resourcePart.startsWith("/")) {
      const prefixed = "/" + resourceSeg;
      if (subtypes[prefixed]) return subtypes[prefixed]!;
    }
    if (subtypes[resourceSeg]) return subtypes[resourceSeg]!;
    if (subtypes[""]) return subtypes[""]!;
  }

  // Simple service→type map
  const mapped = SERVICE_TYPE_MAP[service];
  if (mapped) return mapped;

  return null;
}

/**
 * Extracts the CloudControl primary identifier embedded in an ARN.
 *
 * ARN resource-section formats covered:
 * - `type/id`           → ec2:instance/i-abc → "i-abc"
 * - `type:id`           → rds:db:my-db       → "my-db"
 * - `id` (no separator) → sqs:my-queue       → "my-queue"
 * - `parameter/name`    → ssm:parameter/app  → "/app" (SSM canonical leading slash)
 * - `log-group:/path`   → logs:log-group:/x  → "/x"
 * - `secret:name-suf`   → secret:app/db-Ab   → "app/db-Ab"
 * - `/apis/id`          → apigateway:/apis/x → "x"
 *
 * Returns the full ARN when the shape is unparseable — callers can
 * detect this by comparing against the input.
 */
export function extractIdentifierFromArn(arn: string): string {
  const parts = arn.split(":");
  if (parts.length < 6) return arn;

  const service = parts[2] ?? "";
  // Rejoin everything after the 5th colon — resource section may contain colons.
  const resourceSection = parts.slice(5).join(":");

  // SSM parameters canonically start with "/" and use slash (not colon)
  // after "parameter". The generic colon/slash branches below would strip
  // the "parameter/" prefix and lose the canonical leading "/" that SSM
  // and CloudControl require for nested parameter names.
  if (service === "ssm" && resourceSection.startsWith("parameter/")) {
    return "/" + resourceSection.slice("parameter/".length);
  }

  // Colon-separated: "type:identifier" (rds:db:name, cloudwatch:alarm:name, etc.)
  const colonParts = resourceSection.split(":");
  if (colonParts.length >= 2) {
    const resourceType = colonParts[0]!;
    const afterType = colonParts.slice(1).join(":");

    // Standalone "parameter" (SSM) — already handled above, but keep
    // this branch as a defense for ARNs that arrive with a different
    // service prefix (legacy tooling).
    if (resourceType === "parameter") {
      return resourceSection.slice("parameter/".length);
    }
    if (resourceType === "log-group") {
      return afterType;
    }
    if (resourceType === "secret") {
      return afterType;
    }
    if (afterType && !resourceType.includes("/")) {
      return afterType;
    }
  }

  // Slash-separated: "type/identifier" or "/apis/id"
  const slashIdx = resourceSection.indexOf("/");
  if (slashIdx !== -1) {
    if (resourceSection.startsWith("/")) {
      const segments = resourceSection.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? arn;
    }
    return resourceSection.slice(slashIdx + 1) || arn;
  }

  // No separator — the resource section IS the identifier.
  return resourceSection || arn;
}

/**
 * Extracts the AWS region from an ARN, or returns the default if the
 * ARN has no region segment (S3, IAM, and other global services).
 */
export function extractRegionFromArn(
  arn: string,
  defaultRegion: string,
): string {
  const parts = arn.split(":");
  return parts[3] || defaultRegion;
}

/**
 * Extracts the 12-digit AWS account ID from an ARN, or `undefined`
 * when the ARN has no account segment (S3, legacy ARN shapes).
 */
export function extractAccountIdFromArn(arn: string): string | undefined {
  const parts = arn.split(":");
  if (parts.length < 5) return undefined;
  const account = parts[4];
  return account && /^\d{12}$/.test(account) ? account : undefined;
}

/**
 * Resource types whose CloudControl primary identifier is the full ARN
 * rather than the extracted name/id. Shared between CLI and MCP
 * destroy flows. If this set drifts out of sync with
 * `ARN_IDENTIFIED_TYPES` in `destroy-service.ts`, CloudControl
 * `DeleteResource` calls silently return `NotFound`.
 */
export const ARN_IDENTIFIED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  RESOURCE_TYPES.ELBV2_LOAD_BALANCER, // LoadBalancerArn
  RESOURCE_TYPES.SNS_TOPIC, // TopicArn
  RESOURCE_TYPES.ECS_CLUSTER, // Arn
  RESOURCE_TYPES.EVENTS_RULE, // Arn
  RESOURCE_TYPES.SNS_SUBSCRIPTION, // Arn
  RESOURCE_TYPES.SECRETSMANAGER_SECRET, // full ARN
]);

/**
 * Returns the correct CloudControl `Identifier` for a given ARN and
 * resource type. Three cases:
 *
 *   1. Resource type uses the full ARN as its primary identifier
 *      (SNS Topic, ELBv2, ECS Cluster, etc.) → return the ARN unchanged.
 *   2. SQS Queue: CloudControl identifier is the queue URL, which we
 *      reconstruct from the ARN's region/account/name.
 *   3. Everything else: extract the name/id from the ARN.
 *
 * @example
 *   getCloudControlIdentifier("arn:aws:sns:us-east-1:0:t", "AWS::SNS::Topic")
 *     // → "arn:aws:sns:us-east-1:0:t"
 *   getCloudControlIdentifier("arn:aws:sqs:us-east-1:0:q", "AWS::SQS::Queue")
 *     // → "https://sqs.us-east-1.amazonaws.com/0/q"
 *   getCloudControlIdentifier("arn:aws:s3:::b", "AWS::S3::Bucket")
 *     // → "b"
 */
export function getCloudControlIdentifier(
  arn: string,
  resourceType: string | null,
): string {
  if (resourceType && ARN_IDENTIFIED_RESOURCE_TYPES.has(resourceType)) {
    return arn;
  }

  // SQS Queues: CloudControl identifier is the queue URL.
  if (resourceType === RESOURCE_TYPES.SQS_QUEUE) {
    const parts = arn.split(":");
    const region = parts[3] ?? "";
    const accountId = parts[4] ?? "";
    const queueName = parts[5] ?? "";
    return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
  }

  return extractIdentifierFromArn(arn);
}
