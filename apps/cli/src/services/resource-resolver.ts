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
import type { AwsConfig } from "./cloudcontrol-client.js";
import { ConfigurationError } from "@assignee/core";

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
 */
function isArn(input: string): boolean {
  return input.startsWith("arn:aws:");
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
 * e.g. "arn:aws:s3:::my-bucket" → "AWS::S3::Bucket"
 *
 * Returns null if the ARN service is not recognized.
 */
function arnToResourceType(arn: string): string | null {
  const parts = arn.split(":");
  if (parts.length < 6) return null;

  const service = parts[2];
  const resourcePart = parts[5] ?? "";
  const segments = resourcePart.split("/").filter(Boolean);
  const resourceType = segments[0] ?? "";

  const serviceMap: Record<string, Record<string, string>> = {
    // Tier 0
    s3: { "": "AWS::S3::Bucket" },
    ssm: { parameter: "AWS::SSM::Parameter" },
    iam: {
      role: "AWS::IAM::Role",
      policy: "AWS::IAM::ManagedPolicy",
      user: "AWS::IAM::User",
      group: "AWS::IAM::Group",
      "instance-profile": "AWS::IAM::InstanceProfile",
    },
    ec2: {
      instance: "AWS::EC2::Instance",
      vpc: "AWS::EC2::VPC",
      subnet: "AWS::EC2::Subnet",
      "security-group": "AWS::EC2::SecurityGroup",
      // Tier 1 networking
      "internet-gateway": "AWS::EC2::InternetGateway",
      "route-table": "AWS::EC2::RouteTable",
      natgateway: "AWS::EC2::NatGateway",
    },
    rds: { db: "AWS::RDS::DBInstance" },
    lambda: {
      function: "AWS::Lambda::Function",
      "event-source-mapping": "AWS::Lambda::EventSourceMapping",
    },
    dynamodb: { table: "AWS::DynamoDB::Table" },
    sqs: { "": "AWS::SQS::Queue" },
    sns: { "": "AWS::SNS::Topic" },
    elasticloadbalancing: {
      loadbalancer: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    },
    ecs: { cluster: "AWS::ECS::Cluster" },
    ecr: { repository: "AWS::ECR::Repository" },
    // Tier 1
    logs: { "log-group": "AWS::Logs::LogGroup" },
    // Tier 2
    cloudwatch: { alarm: "AWS::CloudWatch::Alarm" },
    secretsmanager: { secret: "AWS::SecretsManager::Secret" },
    apigateway: { apis: "AWS::ApiGatewayV2::Api" },
    "execute-api": { "": "AWS::ApiGatewayV2::Api" },
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

  const resourceSection = parts.slice(5).join(":");

  // Colon-separated: "type:identifier" (rds:db:name, cloudwatch:alarm:name, etc.)
  const colonParts = resourceSection.split(":");
  if (colonParts.length >= 2) {
    const resourceType = colonParts[0]!;
    const afterType = colonParts.slice(1).join(":");

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
  if (resourceType === "AWS::SNS::Topic") {
    return arn;
  }

  // SQS Queues: CloudControl identifier is the queue URL
  if (resourceType === "AWS::SQS::Queue") {
    const parts = arn.split(":");
    const region = parts[3] ?? "";
    const accountId = parts[4] ?? "";
    const queueName = parts[5] ?? "";
    return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
  }

  // ELBv2 LoadBalancer: CloudControl identifier is the full ARN
  if (resourceType === "AWS::ElasticLoadBalancingV2::LoadBalancer") {
    return arn;
  }

  // ECS Cluster: CloudControl identifier is the full ARN
  if (resourceType === "AWS::ECS::Cluster") {
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
    throw new ConfigurationError(
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID is missing or empty",
    );
  }
  if (!config.secretAccessKey) {
    throw new ConfigurationError(
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY is missing or empty",
    );
  }

  return new ResourceGroupsTaggingAPIClient({
    region: config.region || "us-east-1",
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
        arn.startsWith("arn:aws:sqs:") &&
        arn.endsWith(":" + parsed.queueName)
      ) {
        return {
          arn,
          resourceType: "AWS::SQS::Queue",
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
 * Resolves a resource by name — searches all managed resources for a matching identifier.
 */
async function resolveByName(
  name: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  defaultRegion: string,
): Promise<ResolvedResource | null> {
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

      const nameFromArn = extractIdentifierFromArn(arn);
      if (nameFromArn === name) {
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
