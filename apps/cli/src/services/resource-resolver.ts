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
  const resourceType = resourcePart.split("/")[0] ?? "";

  const serviceMap: Record<string, Record<string, string>> = {
    s3: { "": "AWS::S3::Bucket" },
    ssm: { parameter: "AWS::SSM::Parameter" },
    iam: { role: "AWS::IAM::Role" },
    ec2: {
      instance: "AWS::EC2::Instance",
      vpc: "AWS::EC2::VPC",
      subnet: "AWS::EC2::Subnet",
      "security-group": "AWS::EC2::SecurityGroup",
    },
    rds: { db: "AWS::RDS::DBInstance" },
    lambda: {
      function: "AWS::Lambda::Function",
      "event-source-mapping": "AWS::Lambda::EventSourceMapping",
    },
    dynamodb: { table: "AWS::DynamoDB::Table" },
    sqs: { "": "AWS::SQS::Queue" },
    sns: {
      "": "AWS::SNS::Topic",
    },
    elasticloadbalancing: {
      loadbalancer: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    },
    ecs: { cluster: "AWS::ECS::Cluster" },
    ecr: { repository: "AWS::ECR::Repository" },
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
  // For S3: arn:aws:s3:::bucket-name → parts[5] = "bucket-name"
  // For Lambda: arn:aws:lambda:region:account:function:name → parts[6] = "name"
  // For IAM: arn:aws:iam::account:role/role-name → resourcePart = "role/role-name"
  // General: take the resource portion (parts[5:]), join by ":",
  // then split by "/" to get the last segment
  const resourceSection = parts.slice(5).join(":");
  // Split by both "/" and ":" to extract the final identifier
  const segments = resourceSection.split(/[:/]/).filter(Boolean);
  return segments[segments.length - 1] ?? arn;
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
          identifier: extractIdentifierFromArn(arn),
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

      const identifier = extractIdentifierFromArn(arn);
      if (identifier === name) {
        const resourceType = arnToResourceType(arn);
        return {
          arn,
          resourceType: resourceType ?? "Unknown",
          region: extractRegionFromArn(arn, defaultRegion),
          tags: tagsToRecord(mapping),
          identifier,
        };
      }
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return null;
}
