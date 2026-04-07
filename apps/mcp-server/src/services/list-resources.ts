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
import {
  ASSIGNEE_DIR,
  DEFAULT_AWS_REGION,
  AssigneeTag,
  CostEstimateLabel,
  UNKNOWN_FALLBACK,
  arnToCloudFormationType,
} from "@assignee/core";

/** Tag key/value used to identify assignee-managed resources. */
const TAG_KEY_MANAGED_BY = AssigneeTag.KEY;
const TAG_VALUE_MANAGED_BY = AssigneeTag.VALUE;

/** Default AWS region when none is specified. */
const DEFAULT_REGION = process.env["AWS_REGION"] ?? DEFAULT_AWS_REGION;

/** File name for the provision log in the memory directory.
 * @see apps/cli/src/config/constants.ts FileName.PROVISIONS — keep in sync */
const PROVISIONS_FILE = "provisions.json";

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
 * Parses an ARN into its components.
 */
function parseArn(arn: string): {
  service: string;
  region: string;
  resourceType: string;
} {
  const parts = arn.split(":");
  return {
    service: parts[2] ?? UNKNOWN_FALLBACK,
    region: parts[3] ?? UNKNOWN_FALLBACK,
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
    ASSIGNEE_DIR,
    "memory",
    PROVISIONS_FILE,
  );

  try {
    const raw = fs.readFileSync(provisionLogPath, "utf-8");
    const entries: ProvisionLogEntry[] = JSON.parse(raw);

    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (entry.resourceArn && entry.estimatedMonthlyCost) {
          const key = entry.resourceArn;
          costMap.set(key, entry.estimatedMonthlyCost);
          // Also index by the resource name suffix for cross-format matching
          // (provision log may store QueueUrl but Tagging API returns ARN)
          const name = key.split("/").pop() ?? key.split(":").pop() ?? "";
          if (name) costMap.set(name, entry.estimatedMonthlyCost);
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
        createdDate: createdTag?.Value ?? CostEstimateLabel.NA,
        estimatedMonthlyCost:
          costMap.get(arn) ??
          costMap.get(arn.split("/").pop() ?? "") ??
          costMap.get(arn.split(":").pop() ?? "") ??
          CostEstimateLabel.NA,
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
