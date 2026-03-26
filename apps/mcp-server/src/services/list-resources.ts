/**
 * Service for listing AWS resources managed by assignee.ai.
 *
 * Ported from apps/cli/src/services/list-resources.ts for use
 * inside the MCP server (no CLI dependencies).
 *
 * Queries the Resource Groups Tagging API for resources tagged with
 * `managed-by=assignee-ai` and enriches results with cost data from
 * the provision log.
 *
 * @see Story 20.4, Story 18.4
 */

import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
  type GetResourcesOutput,
} from "@aws-sdk/client-resource-groups-tagging-api";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Tag key/value used to identify assignee-managed resources. */
const TAG_KEY_MANAGED_BY = "managed-by";
const TAG_VALUE_MANAGED_BY = "assignee-ai";

/** Default AWS region when none is specified. */
const DEFAULT_REGION = process.env["AWS_REGION"] ?? "us-east-1";

/** Shape of a managed resource returned by the list service. */
export interface ManagedResource {
  resourceType: string;
  arn: string;
  region: string;
  createdDate: string;
  estimatedMonthlyCost: string;
}

/** Shape of a provision log entry from ~/.assignee/memory/provisions.json. */
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
 */
/** Simple service→type map for services with a single resource type. */
const SERVICE_TYPE_MAP: Record<string, string> = {
  s3: "AWS::S3::Bucket",
  lambda: "AWS::Lambda::Function",
  rds: "AWS::RDS::DBInstance",
  dynamodb: "AWS::DynamoDB::Table",
  sqs: "AWS::SQS::Queue",
  sns: "AWS::SNS::Topic",
  iam: "AWS::IAM::Role",
  cloudformation: "AWS::CloudFormation::Stack",
  logs: "AWS::Logs::LogGroup",
  events: "AWS::Events::Rule",
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
 * Services with multiple resource types — resolved by ARN resource segment.
 * Key: service name, Value: map of resource-segment → CFN type.
 */
const SERVICE_SUBTYPE_MAP: Record<string, Record<string, string>> = {
  ec2: {
    instance: "AWS::EC2::Instance",
    vpc: "AWS::EC2::VPC",
    subnet: "AWS::EC2::Subnet",
    "security-group": "AWS::EC2::SecurityGroup",
    "internet-gateway": "AWS::EC2::InternetGateway",
    "route-table": "AWS::EC2::RouteTable",
    natgateway: "AWS::EC2::NatGateway",
    "elastic-ip": "AWS::EC2::EIP",
  },
  apigateway: {
    "/apis": "AWS::ApiGatewayV2::Api",
    restapis: "AWS::ApiGateway::RestApi",
  },
  "execute-api": {
    "": "AWS::ApiGatewayV2::Api",
  },
  elasticloadbalancing: {
    loadbalancer: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    targetgroup: "AWS::ElasticLoadBalancingV2::TargetGroup",
  },
  ecr: {
    repository: "AWS::ECR::Repository",
  },
  cloudwatch: {
    alarm: "AWS::CloudWatch::Alarm",
  },
  ssm: {
    parameter: "AWS::SSM::Parameter",
  },
};

/**
 * Converts an AWS service name and resource component from an ARN
 * into a CloudFormation-style type string.
 */
function arnToCloudFormationType(
  service: string,
  resourcePart: string,
): string {
  // Check subtype map first (for services with multiple resource types)
  const subtypes = SERVICE_SUBTYPE_MAP[service];
  if (subtypes) {
    // Extract resource type segment from ARN resource part
    const segments = resourcePart.split(/[:/]/).filter(Boolean);
    const resourceSeg = segments[0] ?? "";
    // Check prefixed form (e.g., "/apis" for apigateway)
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

  // Fallback: construct from service + resource
  const capitalizedService = service.charAt(0).toUpperCase() + service.slice(1);
  const resourceType = resourcePart.split(/[:/]/)[0] ?? "Resource";
  const capitalizedResource =
    resourceType.charAt(0).toUpperCase() + resourceType.slice(1);

  return `AWS::${capitalizedService}::${capitalizedResource}`;
}

/**
 * Parses an ARN into its components.
 */
function parseArn(arn: string): {
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
 * @param region - AWS region to query (defaults to AWS_REGION env var or us-east-1)
 * @param resourceType - Optional filter by CloudFormation resource type
 * @returns Array of managed resources
 */
export async function fetchManagedResources(
  region?: string,
  resourceType?: string,
): Promise<ManagedResource[]> {
  const resolvedRegion = region ?? DEFAULT_REGION;
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

  // Filter by resource type if specified
  if (resourceType) {
    return resources.filter((r) => r.resourceType === resourceType);
  }

  return resources;
}
