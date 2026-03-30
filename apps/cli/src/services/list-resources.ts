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
import type { StructuredTool } from "@langchain/core/tools";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RESOURCE_TYPES, COMPANION_RESOURCE_TYPES, LIST_RESOURCE_TYPES, CCAPI_FALLBACK_TYPES } from "@assignee/core";
import { AWS_REGION } from "../config/constants.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import { TAG_KEY_MANAGED_BY, TAG_VALUE_MANAGED_BY } from "../utils/tags.js";
import { fetchBillingData } from "./billing.js";

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
/** Simple service→type map for services with a single resource type. */
const SERVICE_TYPE_MAP: Record<string, string> = {
  s3: RESOURCE_TYPES.S3_BUCKET,
  lambda: RESOURCE_TYPES.LAMBDA_FUNCTION,
  rds: RESOURCE_TYPES.RDS_DB_INSTANCE,
  dynamodb: RESOURCE_TYPES.DYNAMODB_TABLE,
  sqs: RESOURCE_TYPES.SQS_QUEUE,
  sns: RESOURCE_TYPES.SNS_TOPIC,
  cloudformation: LIST_RESOURCE_TYPES.CLOUDFORMATION_STACK,
  logs: RESOURCE_TYPES.LOGS_LOG_GROUP,
  events: LIST_RESOURCE_TYPES.EVENTS_RULE,
  cloudfront: LIST_RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  ecs: RESOURCE_TYPES.ECS_CLUSTER,
  eks: LIST_RESOURCE_TYPES.EKS_CLUSTER,
  elasticache: LIST_RESOURCE_TYPES.ELASTICACHE_CACHE_CLUSTER,
  kinesis: LIST_RESOURCE_TYPES.KINESIS_STREAM,
  secretsmanager: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
  stepfunctions: LIST_RESOURCE_TYPES.STEPFUNCTIONS_STATE_MACHINE,
  states: LIST_RESOURCE_TYPES.STEPFUNCTIONS_STATE_MACHINE,
};

/** Services with multiple resource types — resolved by ARN resource segment. */
const SERVICE_SUBTYPE_MAP: Record<string, Record<string, string>> = {
  ec2: {
    instance: RESOURCE_TYPES.EC2_INSTANCE,
    vpc: RESOURCE_TYPES.EC2_VPC,
    subnet: RESOURCE_TYPES.EC2_SUBNET,
    "security-group": RESOURCE_TYPES.EC2_SECURITY_GROUP,
    "internet-gateway": RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
    "route-table": RESOURCE_TYPES.EC2_ROUTE_TABLE,
    natgateway: RESOURCE_TYPES.EC2_NAT_GATEWAY,
    "elastic-ip": COMPANION_RESOURCE_TYPES.EC2_EIP,
  },
  iam: {
    role: RESOURCE_TYPES.IAM_ROLE,
    policy: LIST_RESOURCE_TYPES.IAM_MANAGED_POLICY,
    user: LIST_RESOURCE_TYPES.IAM_USER,
    group: LIST_RESOURCE_TYPES.IAM_GROUP,
    "instance-profile": LIST_RESOURCE_TYPES.IAM_INSTANCE_PROFILE,
  },
  apigateway: {
    "/apis": RESOURCE_TYPES.APIGATEWAYV2_API,
    restapis: LIST_RESOURCE_TYPES.APIGATEWAY_REST_API,
  },
  "execute-api": {
    "": RESOURCE_TYPES.APIGATEWAYV2_API,
  },
  elasticloadbalancing: {
    loadbalancer: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    targetgroup: LIST_RESOURCE_TYPES.ELBV2_TARGET_GROUP,
  },
  ecr: {
    repository: RESOURCE_TYPES.ECR_REPOSITORY,
  },
  cloudwatch: {
    alarm: RESOURCE_TYPES.CLOUDWATCH_ALARM,
  },
  ssm: {
    parameter: RESOURCE_TYPES.SSM_PARAMETER,
  },
};

/**
 * Converts an AWS service name and resource component from an ARN
 * into a CloudFormation-style type string.
 */
export function arnToCloudFormationType(
  service: string,
  resourcePart: string,
): string {
  // Check subtype map first (for services with multiple resource types)
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

  // Fallback: construct from service + resource
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

/** Provision log data keyed by ARN. */
interface ProvisionLookup {
  costMap: Map<string, string>;
  timestampMap: Map<string, string>;
}

/**
 * Reads the provision log file and returns maps of ARN -> estimated monthly cost
 * and ARN -> timestamp. Returns empty maps if the file does not exist or cannot be parsed.
 */
function loadProvisionData(): ProvisionLookup {
  const costMap = new Map<string, string>();
  const timestampMap = new Map<string, string>();
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
        if (entry.resourceArn) {
          const key = entry.resourceArn;
          if (entry.estimatedMonthlyCost) {
            costMap.set(key, entry.estimatedMonthlyCost);
            // Also index by resource name suffix for cross-format matching
            const name = key.split("/").pop() ?? key.split(":").pop() ?? "";
            if (name) costMap.set(name, entry.estimatedMonthlyCost);
          }
          if (entry.timestamp) {
            timestampMap.set(key, entry.timestamp);
            const name = key.split("/").pop() ?? key.split(":").pop() ?? "";
            if (name) timestampMap.set(name, entry.timestamp);
          }
        }
      }
    }
  } catch {
    // File missing or parse error — return empty maps (cost/date shows "N/A")
  }

  return { costMap, timestampMap };
}

/**
 * Fetches all resources tagged with `managed-by=assignee-ai` from AWS.
 * Paginates through all results and enriches with cost data from the provision log.
 *
 * @param region - AWS region to query (defaults to AWS_REGION constant)
 * @param mcpTools - Optional MCP tools for live billing data (Story 19.7)
 * @returns Array of managed resources
 */
export async function fetchManagedResources(
  region?: string,
  mcpTools?: StructuredTool[],
): Promise<ManagedResource[]> {
  const resolvedRegion = region ?? AWS_REGION;
  const opCreds = operatorCredentials();
  const client = new ResourceGroupsTaggingAPIClient({
    region: resolvedRegion,
    ...(opCreds.accessKeyId && opCreds.secretAccessKey
      ? {
          credentials: {
            accessKeyId: opCreds.accessKeyId,
            secretAccessKey: opCreds.secretAccessKey,
          },
        }
      : {}),
  });

  const { costMap, timestampMap } = loadProvisionData();
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

      // Use provision log timestamp; fall back to "N/A"
      // Try matching by full ARN, then by resource name suffix
      const arnName = arn.split("/").pop() ?? arn.split(":").pop() ?? "";
      const createdDate =
        timestampMap.get(arn) ?? timestampMap.get(arnName) ?? "N/A";

      resources.push({
        resourceType: parsed.resourceType,
        arn,
        region: parsed.region || resolvedRegion,
        createdDate,
        estimatedMonthlyCost: costMap.get(arn) ?? costMap.get(arnName) ?? "N/A",
      });
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  // Story 19.7: Enrich with live billing data from the Billing MCP server.
  // Overrides provision log costs when billing MCP data is available.
  if (mcpTools && mcpTools.length > 0 && resources.length > 0) {
    try {
      const billingMap = await fetchBillingData(resources, mcpTools);
      for (const resource of resources) {
        const billingData = billingMap.get(resource.arn);
        if (billingData) {
          resource.estimatedMonthlyCost = billingData.actualMonthlyCost;
        }
      }
    } catch {
      // Billing MCP unavailable — keep provision log costs
    }
  }

  return resources;
}
