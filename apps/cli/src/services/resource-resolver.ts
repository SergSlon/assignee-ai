/**
 * Resource Resolver — resolves resources by ARN or name via Resource Groups Tagging API.
 * Only returns resources managed by assignee.ai (tagged with managed-by=assignee-ai).
 *
 * @see Story 18.5 — assignee destroy command
 */

import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
  type ResourceTagMapping,
} from "@aws-sdk/client-resource-groups-tagging-api";
import { TAG_KEY_MANAGED_BY, TAG_VALUE_MANAGED_BY } from "../utils/tags.js";
import {
  fetchManagedIamRoles,
  getManagedIamRoleByArn,
} from "./iam-role-inventory.js";
import type { AwsConfig } from "./cloudcontrol-client.js";
import {
  ArnPrefix,
  ConfigurationError,
  RESOURCE_TYPES,
  LIST_RESOURCE_TYPES,
} from "@assignee/core";
import {
  AWS_REGION,
  AWS_SERVICE_EXECUTE_API,
  CredentialError,
} from "../config/constants.js";

/** Resolved resource returned by the resource resolver. */
export interface ResolvedResource {
  arn: string;
  resourceType: string;
  region: string;
  tags: Record<string, string>;
  identifier: string;
}

/**
 * Checks if a string looks like an ARN.
 *
 * Wave 10 P0-1: this used to call `input.startsWith(ArnPrefix.AWS)`
 * where `ArnPrefix.AWS === "arn:aws:"` — commercial-only. GovCloud
 * (`arn:aws-us-gov:`) and China (`arn:aws-cn:`) ARNs returned false
 * here and fell through to `resolveByName`, which then attempted to
 * scan RGTA for a literal name match against an ARN string and
 * silently failed to resolve any IAM role / S3 bucket / etc on those
 * partitions. The same partition-aware regex pattern as
 * `isArn()` in `packages/core/src/config/arn-builder.ts`.
 */
function isArn(input: string): boolean {
  return /^arn:aws[\w-]*:/.test(input);
}

/**
 * Checks if a string is an SQS queue URL.
 * Format: https://sqs.{region}.amazonaws.com/{account-id}/{queue-name}
 */
function isSqsQueueUrl(input: string): boolean {
  return /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d+\/[^/]+$/.test(input);
}

/**
 * Parses an SQS queue URL into its components.
 * @param url - SQS queue URL like https://sqs.us-east-1.amazonaws.com/054125018476/my-queue
 * @returns Parsed components or null if not a valid SQS URL
 */
function parseSqsQueueUrl(url: string): {
  region: string;
  accountId: string;
  queueName: string;
} | null {
  const match = url.match(
    /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d+)\/([^/]+)$/,
  );
  if (!match) return null;
  return {
    region: match[1]!,
    accountId: match[2]!,
    queueName: match[3]!,
  };
}

/**
 * Extracts the CloudFormation resource type from an ARN.
 * e.g. "arn:aws:s3:::my-bucket" → RESOURCE_TYPES.S3_BUCKET
 *
 * Returns null if the ARN service is not recognized.
 */
function arnToResourceType(arn: string): string | null {
  const parts = arn.split(":");
  if (parts.length < 6) return null;

  const service = parts[2] ?? "";
  const resourcePart = parts[5] ?? "";
  const segments = resourcePart.split("/").filter(Boolean);
  const resourceType = segments[0] ?? "";

  const serviceMap: Record<string, Record<string, string>> = {
    // Tier 0
    s3: { "": RESOURCE_TYPES.S3_BUCKET },
    ssm: { parameter: RESOURCE_TYPES.SSM_PARAMETER },
    iam: {
      role: RESOURCE_TYPES.IAM_ROLE,
      policy: LIST_RESOURCE_TYPES.IAM_MANAGED_POLICY,
      user: LIST_RESOURCE_TYPES.IAM_USER,
      group: LIST_RESOURCE_TYPES.IAM_GROUP,
      "instance-profile": LIST_RESOURCE_TYPES.IAM_INSTANCE_PROFILE,
    },
    ec2: {
      instance: RESOURCE_TYPES.EC2_INSTANCE,
      vpc: RESOURCE_TYPES.EC2_VPC,
      subnet: RESOURCE_TYPES.EC2_SUBNET,
      "security-group": RESOURCE_TYPES.EC2_SECURITY_GROUP,
      // Tier 1 networking
      "internet-gateway": RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
      "route-table": RESOURCE_TYPES.EC2_ROUTE_TABLE,
      natgateway: RESOURCE_TYPES.EC2_NAT_GATEWAY,
    },
    rds: { db: RESOURCE_TYPES.RDS_DB_INSTANCE },
    lambda: {
      function: RESOURCE_TYPES.LAMBDA_FUNCTION,
      "event-source-mapping": LIST_RESOURCE_TYPES.LAMBDA_EVENT_SOURCE_MAPPING,
    },
    dynamodb: { table: RESOURCE_TYPES.DYNAMODB_TABLE },
    sqs: { "": RESOURCE_TYPES.SQS_QUEUE },
    sns: { "": RESOURCE_TYPES.SNS_TOPIC },
    elasticloadbalancing: {
      loadbalancer: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    },
    ecs: { cluster: RESOURCE_TYPES.ECS_CLUSTER },
    ecr: { repository: RESOURCE_TYPES.ECR_REPOSITORY },
    // Tier 1
    logs: { "log-group": RESOURCE_TYPES.LOGS_LOG_GROUP },
    // Tier 2
    cloudwatch: { alarm: RESOURCE_TYPES.CLOUDWATCH_ALARM },
    secretsmanager: { secret: RESOURCE_TYPES.SECRETSMANAGER_SECRET },
    apigateway: { apis: RESOURCE_TYPES.APIGATEWAYV2_API },
    [AWS_SERVICE_EXECUTE_API]: { "": RESOURCE_TYPES.APIGATEWAYV2_API },
  };

  if (!service) return null;
  const serviceTypes = serviceMap[service];
  if (!serviceTypes) return null;

  return serviceTypes[resourceType] ?? serviceTypes[""] ?? null;
}

/**
 * Extracts the identifier (name/id) from an ARN.
 * e.g. "arn:aws:s3:::my-bucket" → "my-bucket"
 * e.g. "arn:aws:lambda:us-east-1:123:function:my-func" → "my-func"
 */
function extractIdentifierFromArn(arn: string): string {
  const parts = arn.split(":");
  if (parts.length < 6) return arn;

  const service = parts[2] ?? "";
  const resourceSection = parts.slice(5).join(":");

  // SSM parameters use "parameter/<name>" which has no colon separator, so
  // the generic slash branch below would strip the "parameter/" prefix and
  // lose the canonical leading "/" that SSM and CloudControl require for
  // nested parameter names (e.g. "/myapp/db/host"). Handle it explicitly.
  if (service === "ssm" && resourceSection.startsWith("parameter/")) {
    return "/" + resourceSection.slice("parameter/".length);
  }

  // Colon-separated: "type:identifier" (rds:db:name, cloudwatch:alarm:name, etc.)
  const colonParts = resourceSection.split(":");
  if (colonParts.length >= 2) {
    const resourceType = colonParts[0]!;
    const afterType = colonParts.slice(1).join(":");

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

  // Slash-separated: "type/identifier"
  const slashIdx = resourceSection.indexOf("/");
  if (slashIdx !== -1) {
    if (resourceSection.startsWith("/")) {
      const segments = resourceSection.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? arn;
    }
    return resourceSection.slice(slashIdx + 1) || arn;
  }

  return resourceSection || arn;
}

/**
 * Returns the correct CloudControl identifier for a given ARN and resource type.
 *
 * Most resource types use the extracted name/id from the ARN, but some types
 * require specific identifier formats:
 * - AWS::SNS::Topic uses the full TopicArn as identifier
 * - AWS::SQS::Queue uses the queue URL as identifier
 * - AWS::ElasticLoadBalancingV2::LoadBalancer uses the full ARN as identifier
 * - AWS::ECS::Cluster uses the full ARN as identifier
 */
function getCloudControlIdentifier(
  arn: string,
  resourceType: string | null,
): string {
  // SNS Topics: CloudControl identifier is the full TopicArn
  if (resourceType === RESOURCE_TYPES.SNS_TOPIC) {
    return arn;
  }

  // SQS Queues: CloudControl identifier is the queue URL
  if (resourceType === RESOURCE_TYPES.SQS_QUEUE) {
    const parts = arn.split(":");
    const region = parts[3] ?? "";
    const accountId = parts[4] ?? "";
    const queueName = parts[5] ?? "";
    return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
  }

  // ELBv2 LoadBalancer: CloudControl identifier is the full ARN
  if (resourceType === RESOURCE_TYPES.ELBV2_LOAD_BALANCER) {
    return arn;
  }

  // ECS Cluster: CloudControl identifier is the full ARN
  if (resourceType === RESOURCE_TYPES.ECS_CLUSTER) {
    return arn;
  }

  // Default: extract the name/id from the ARN
  return extractIdentifierFromArn(arn);
}

/**
 * Extracts the region from an ARN.
 * Returns the provided default if the ARN has no region (e.g. S3, IAM).
 */
function extractRegionFromArn(arn: string, defaultRegion: string): string {
  const parts = arn.split(":");
  return parts[3] || defaultRegion;
}

/**
 * Creates a ResourceGroupsTaggingAPIClient with validated credentials.
 */
export function createTaggingClient(
  config: AwsConfig,
): ResourceGroupsTaggingAPIClient {
  if (!config.accessKeyId) {
    throw new ConfigurationError(CredentialError.MISSING_ACCESS_KEY);
  }
  if (!config.secretAccessKey) {
    throw new ConfigurationError(CredentialError.MISSING_SECRET_KEY);
  }

  return new ResourceGroupsTaggingAPIClient({
    region: config.region || AWS_REGION,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Converts a ResourceTagMapping's tag list to a flat key-value record.
 */
function tagsToRecord(mapping: ResourceTagMapping): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of mapping.Tags ?? []) {
    if (tag.Key && tag.Value !== undefined) {
      tags[tag.Key] = tag.Value;
    }
  }
  return tags;
}

/**
 * Resolves a resource by ARN or name using the Resource Groups Tagging API.
 * Only returns resources tagged with managed-by=assignee-ai.
 *
 * @param input - Resource ARN or name
 * @param taggingClient - Pre-configured ResourceGroupsTaggingAPIClient
 * @param region - Default AWS region
 * @returns ResolvedResource or null if not found / not managed
 */
export async function resolveResource(
  input: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<ResolvedResource | null> {
  if (isArn(input)) {
    return resolveByArn(input, taggingClient, region);
  }

  // SQS queue URLs: the CloudControl identifier for AWS::SQS::Queue IS the queue URL.
  // Resolve by extracting the queue name and searching managed resources.
  if (isSqsQueueUrl(input)) {
    return resolveSqsQueueUrl(input, taggingClient, region);
  }

  return resolveByName(input, taggingClient, region);
}

/**
 * Resolves a resource by ARN — validates it exists and is managed by assignee.ai.
 */
async function resolveByArn(
  arn: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  defaultRegion: string,
): Promise<ResolvedResource | null> {
  // IAM::Role: Resource Groups Tagging API does NOT return roles, so
  // fall through to a direct iam:GetRole + iam:ListRoleTags lookup
  // before scanning RGTA. See iam-role-inventory.ts. Partition-aware
  // pattern (matches aws / aws-us-gov / aws-cn) so GovCloud and China
  // users can resolve IAM role ARNs the same way commercial users can.
  if (/^arn:aws[\w-]*:iam::\d+:role\//.test(arn)) {
    const role = await getManagedIamRoleByArn(arn);
    if (role) {
      return {
        arn: role.arn,
        resourceType: RESOURCE_TYPES.IAM_ROLE,
        region: defaultRegion,
        tags: role.tags,
        identifier: role.roleName,
      };
    }
    return null;
  }

  // Query tagging API for this specific ARN with managed-by filter
  let paginationToken: string | undefined;
  do {
    const response = await taggingClient.send(
      new GetResourcesCommand({
        TagFilters: [
          { Key: TAG_KEY_MANAGED_BY, Values: [TAG_VALUE_MANAGED_BY] },
        ],
        PaginationToken: paginationToken,
      }),
    );

    for (const mapping of response.ResourceTagMappingList ?? []) {
      if (mapping.ResourceARN === arn) {
        const resourceType = arnToResourceType(arn);
        return {
          arn,
          resourceType: resourceType ?? "Unknown",
          region: extractRegionFromArn(arn, defaultRegion),
          tags: tagsToRecord(mapping),
          identifier: getCloudControlIdentifier(arn, resourceType),
        };
      }
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return null;
}

/**
 * Resolves an SQS queue by its queue URL.
 * The queue URL IS the CloudControl identifier for AWS::SQS::Queue.
 * Searches managed resources for a matching SQS queue name, then returns
 * the resolved resource with the queue URL as the identifier.
 */
async function resolveSqsQueueUrl(
  queueUrl: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  defaultRegion: string,
): Promise<ResolvedResource | null> {
  const parsed = parseSqsQueueUrl(queueUrl);
  if (!parsed) return null;

  // Search managed resources for an SQS queue with a matching name
  let paginationToken: string | undefined;
  do {
    const response = await taggingClient.send(
      new GetResourcesCommand({
        TagFilters: [
          { Key: TAG_KEY_MANAGED_BY, Values: [TAG_VALUE_MANAGED_BY] },
        ],
        PaginationToken: paginationToken,
      }),
    );

    for (const mapping of response.ResourceTagMappingList ?? []) {
      const arn = mapping.ResourceARN;
      if (!arn) continue;

      // Match SQS ARN: arn:aws:sqs:{region}:{account}:{queue-name}
      if (
        arn.startsWith(ArnPrefix.SQS) &&
        arn.endsWith(":" + parsed.queueName)
      ) {
        return {
          arn,
          resourceType: RESOURCE_TYPES.SQS_QUEUE,
          region: parsed.region || defaultRegion,
          tags: tagsToRecord(mapping),
          identifier: queueUrl, // CloudControl identifier for SQS is the queue URL
        };
      }
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return null;
}

/**
 * Checks whether a given user-provided `name` matches the identifier encoded
 * in `arn`. Supports multiple valid normalizations so users can destroy a
 * resource via the same string that appears in `assignee list`:
 *
 * - Exact match against the extracted ARN identifier
 * - SSM parameters: accept both leading-slash ("/foo/bar") and bare ("foo/bar")
 *   forms; the canonical SSM identifier always has a leading slash but users
 *   commonly paste the bare form they originally created.
 * - CloudWatch Logs log groups: accept with/without leading slash for the same
 *   reason (e.g. "/aws/lambda/fn" vs "aws/lambda/fn").
 */
function matchesName(arn: string, name: string): boolean {
  const nameFromArn = extractIdentifierFromArn(arn);
  if (nameFromArn === name) return true;

  // SSM parameters and CloudWatch Logs log groups use leading-slash
  // identifiers canonically, but users routinely paste the bare form that
  // they originally supplied on create (e.g. `smoke-test-x` vs
  // `/smoke-test-x`). For these types only, also match the slash-stripped
  // variant so `assignee destroy` accepts both forms. We do NOT fall back to
  // a global slash-stripping match — that would make "/my-bucket" match an
  // unrelated S3 bucket named "my-bucket".
  const isSlashPrefixedType =
    arn.includes(":parameter/") || arn.includes(":log-group:");
  if (!isSlashPrefixedType) return false;

  const stripLeading = (s: string) => (s.startsWith("/") ? s.slice(1) : s);
  return stripLeading(nameFromArn) === stripLeading(name);
}

/**
 * Resolves a resource by name — searches all managed resources for a matching identifier.
 *
 * Wave 10 P1-5: previously walked iam:ListRoles + iam:ListRoleTags
 * UNCONDITIONALLY before scanning RGTA, which added ~200 AWS API
 * calls to every `assignee destroy <name>` even when the user named
 * a non-IAM resource. RGTA is scanned first now; the IAM fallback
 * only fires when RGTA produced no match, eliminating the perf
 * regression for the common case while still supporting IAM-by-name
 * resolution (RGTA does not return IAM roles, so the fallback is
 * the only path for IAM byName destroys).
 */
async function resolveByName(
  name: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  defaultRegion: string,
): Promise<ResolvedResource | null> {
  // ── Phase 1: scan RGTA first (covers every non-IAM-Role type) ────
  let paginationToken: string | undefined;
  do {
    const response = await taggingClient.send(
      new GetResourcesCommand({
        TagFilters: [
          { Key: TAG_KEY_MANAGED_BY, Values: [TAG_VALUE_MANAGED_BY] },
        ],
        PaginationToken: paginationToken,
      }),
    );

    for (const mapping of response.ResourceTagMappingList ?? []) {
      const arn = mapping.ResourceARN;
      if (!arn) continue;

      if (matchesName(arn, name)) {
        const resourceType = arnToResourceType(arn);
        return {
          arn,
          resourceType: resourceType ?? "Unknown",
          region: extractRegionFromArn(arn, defaultRegion),
          tags: tagsToRecord(mapping),
          identifier: getCloudControlIdentifier(arn, resourceType),
        };
      }
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  // ── Phase 2: IAM::Role fallback (RGTA doesn't return IAM roles) ──
  // Only walk iam:ListRoles when RGTA found nothing — this preserves
  // IAM byName resolution while removing the perf regression for the
  // 99% of byName destroys that target non-IAM resources.
  try {
    const iamRoles = await fetchManagedIamRoles();
    for (const role of iamRoles) {
      if (role.roleName === name || role.arn === name) {
        return {
          arn: role.arn,
          resourceType: RESOURCE_TYPES.IAM_ROLE,
          region: defaultRegion,
          tags: role.tags,
          identifier: role.roleName,
        };
      }
    }
  } catch {
    // Non-fatal: caller treats null as "not found". The list command
    // emits a clearer warning when iam:ListRoles is missing.
  }

  return null;
}
