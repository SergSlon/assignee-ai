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
import {
  CCAPI_FALLBACK_TYPES,
  CostEstimateLabel,
  arnToCloudFormationType,
} from "@assignee/core";
import {
  ASSIGNEE_DIR,
  AWS_REGION,
  AWS_SERVICE_EXECUTE_API,
  PROVISIONS_FILE,
  UNKNOWN_FALLBACK,
} from "../config/constants.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import { TAG_KEY_MANAGED_BY, TAG_VALUE_MANAGED_BY } from "../utils/tags.js";
import { fetchBillingData } from "./billing.js";
import { getFreeTierCostLabel } from "../utils/free-tier.js";

// Re-export for consumers that import from this module
export { arnToCloudFormationType } from "@assignee/core";

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
    service: parts[2] ?? UNKNOWN_FALLBACK,
    region: parts[3] ?? UNKNOWN_FALLBACK,
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
    ASSIGNEE_DIR,
    "memory",
    PROVISIONS_FILE,
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
  } catch (err: unknown) {
    // Only warn if the file exists but is corrupted — missing file is normal for new users
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      process.stderr.write(
        "⚠ Warning: Provision log is corrupted or unreadable. Run 'assignee clean --memory' to reset.\n",
      );
    }
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
        timestampMap.get(arn) ??
        timestampMap.get(arnName) ??
        CostEstimateLabel.NA;

      resources.push({
        resourceType: parsed.resourceType,
        arn,
        region: parsed.region || resolvedRegion,
        createdDate,
        estimatedMonthlyCost:
          costMap.get(arn) ??
          costMap.get(arnName) ??
          getFreeTierCostLabel(parsed.resourceType) ??
          CostEstimateLabel.NA,
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
