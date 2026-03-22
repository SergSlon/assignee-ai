/**
 * Service for listing AWS resources managed by assignee.ai.
 *
 * Queries the Resource Groups Tagging API for resources tagged with
 * `managed-by=assignee-ai` and enriches results with cost data from
 * the provision log when available.
 *
 * @see Story 18.4, FR-40
 */

import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
  type GetResourcesOutput,
} from "@aws-sdk/client-resource-groups-tagging-api";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AWS_REGION } from "../config/constants.js";
import { TAG_KEY_MANAGED_BY, TAG_VALUE_MANAGED_BY } from "../utils/tags.js";

/** Shape of a managed resource returned by the list service. */
export interface ManagedResource {
  resourceType: string;
  arn: string;
  region: string;
  createdDate: string;
  estimatedMonthlyCost: string;
}

/** Shape of a provision log entry from ~/.assignee/memory/provisions.json (Story 19.3). */
interface ProvisionLogEntry {
  runId?: string;
  resourceType?: string;
  resourceArn?: string;
  region?: string;
  estimatedMonthlyCost?: string;
  timestamp?: string;
}

/**
 * Maps common AWS service names to CloudFormation resource types.
 * Falls back to `AWS::<Service>::Resource` for unmapped services.
 */
const SERVICE_TYPE_MAP: Record<string, string> = {
  s3: "AWS::S3::Bucket",
  lambda: "AWS::Lambda::Function",
  ec2: "AWS::EC2::Instance",
  rds: "AWS::RDS::DBInstance",
  dynamodb: "AWS::DynamoDB::Table",
  sqs: "AWS::SQS::Queue",
  sns: "AWS::SNS::Topic",
  iam: "AWS::IAM::Role",
  cloudformation: "AWS::CloudFormation::Stack",
  ssm: "AWS::SSM::Parameter",
  logs: "AWS::Logs::LogGroup",
  events: "AWS::Events::Rule",
  apigateway: "AWS::ApiGateway::RestApi",
  cloudfront: "AWS::CloudFront::Distribution",
  ecs: "AWS::ECS::Cluster",
  eks: "AWS::EKS::Cluster",
  elasticache: "AWS::ElastiCache::CacheCluster",
  kinesis: "AWS::Kinesis::Stream",
  secretsmanager: "AWS::SecretsManager::Secret",
  stepfunctions: "AWS::StepFunctions::StateMachine",
  states: "AWS::StepFunctions::StateMachine",
};

/**
 * Converts an AWS service name and resource component from an ARN
 * into a CloudFormation-style type string.
 */
export function arnToCloudFormationType(
  service: string,
  resourcePart: string,
): string {
  const mapped = SERVICE_TYPE_MAP[service];
  if (mapped) return mapped;

  // Capitalize service name for a best-effort CloudFormation type
  const capitalizedService = service.charAt(0).toUpperCase() + service.slice(1);
  const resourceType = resourcePart.split(/[:/]/)[0] ?? "Resource";
  const capitalizedResource =
    resourceType.charAt(0).toUpperCase() + resourceType.slice(1);

  return `AWS::${capitalizedService}::${capitalizedResource}`;
}

/**
 * Parses an ARN into its components.
 *
 * ARN format: arn:partition:service:region:account-id:resource-type/resource-id
 */
export function parseArn(arn: string): {
  service: string;
  region: string;
  resourceType: string;
} {
  const parts = arn.split(":");
  return {
    service: parts[2] ?? "unknown",
    region: parts[3] ?? "unknown",
    resourceType: arnToCloudFormationType(parts[2] ?? "", parts[5] ?? ""),
  };
}

/**
 * Reads the provision log file and returns a map of ARN -> estimated monthly cost.
 * Returns an empty map if the file does not exist or cannot be parsed.
 */
function loadProvisionCosts(): Map<string, string> {
  const costMap = new Map<string, string>();
  const provisionLogPath = path.join(
    os.homedir(),
    ".assignee",
    "memory",
    "provisions.json",
  );

  try {
    const raw = fs.readFileSync(provisionLogPath, "utf-8");
    const entries: ProvisionLogEntry[] = JSON.parse(raw);

    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (entry.resourceArn && entry.estimatedMonthlyCost) {
          costMap.set(entry.resourceArn, entry.estimatedMonthlyCost);
        }
      }
    }
  } catch {
    // File missing or parse error — return empty map (cost shows "N/A")
  }

  return costMap;
}

/**
 * Fetches all resources tagged with `managed-by=assignee-ai` from AWS.
 * Paginates through all results and enriches with cost data from the provision log.
 *
 * @param region - AWS region to query (defaults to AWS_REGION constant)
 * @returns Array of managed resources
 */
export async function fetchManagedResources(
  region?: string,
): Promise<ManagedResource[]> {
  const resolvedRegion = region ?? AWS_REGION;
  const client = new ResourceGroupsTaggingAPIClient({
    region: resolvedRegion,
  });

  const costMap = loadProvisionCosts();
  const resources: ManagedResource[] = [];
  let paginationToken: string | undefined;

  do {
    const command = new GetResourcesCommand({
      TagFilters: [
        {
          Key: TAG_KEY_MANAGED_BY,
          Values: [TAG_VALUE_MANAGED_BY],
        },
      ],
      ...(paginationToken ? { PaginationToken: paginationToken } : {}),
    });

    const response: GetResourcesOutput = await client.send(command);

    for (const mapping of response.ResourceTagMappingList ?? []) {
      const arn = mapping.ResourceARN ?? "";
      const parsed = parseArn(arn);

      // Look for created date from tags
      const createdTag = mapping.Tags?.find((t) => t.Key === "assignee-run-id");

      resources.push({
        resourceType: parsed.resourceType,
        arn,
        region: parsed.region || resolvedRegion,
        createdDate: createdTag?.Value ?? "N/A",
        estimatedMonthlyCost: costMap.get(arn) ?? "N/A",
      });
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return resources;
}
