/**
 * Service for listing AWS resources managed by assignee.ai.
 *
 * Queries the Resource Groups Tagging API for resources tagged with
 * `managed-by=assignee-ai` and enriches results with cost data from
 * the provision log.
 *
 * Uses shared types + ARN parser + provision-log loader from
 * `@assignee/core` (Story 49.2) so MCP and CLI list-output shapes
 * stay consistent.
 *
 * @see Story 20.4, Story 18.4, Story 49.2
 */

import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
  type GetResourcesOutput,
} from "@aws-sdk/client-resource-groups-tagging-api";
import {
  AssigneeTag,
  CostEstimateLabel,
  DEFAULT_AWS_REGION,
  loadProvisionData,
  parseArn,
  type ManagedResource,
} from "@assignee/core";

export type { ManagedResource } from "@assignee/core";

/** Tag key/value used to identify assignee-managed resources. */
const TAG_KEY_MANAGED_BY = AssigneeTag.KEY;
const TAG_VALUE_MANAGED_BY = AssigneeTag.VALUE;

/** Default AWS region when none is specified. */
const DEFAULT_REGION = process.env["AWS_REGION"] ?? DEFAULT_AWS_REGION;

/**
 * Fetches all resources tagged with `managed-by=assignee-ai` from AWS.
 * Paginates through all results and enriches with cost data from the
 * provision log.
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

  try {
    const { costMap } = loadProvisionData();
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

        // Look for created date from tags.
        const createdTag = mapping.Tags?.find(
          (t) => t.Key === "assignee-run-id",
        );

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

    // Filter by resource type if specified.
    if (resourceType) {
      return resources.filter((r) => r.resourceType === resourceType);
    }

    return resources;
  } finally {
    // Story 49.3: dispose the RGTA client — long-running MCP server
    // must not leak sockets per invocation.
    client.destroy();
  }
}
