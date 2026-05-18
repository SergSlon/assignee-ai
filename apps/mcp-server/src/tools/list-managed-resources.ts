/**
 * list_managed_resources MCP tool — lists resources provisioned by assignee.ai.
 *
 * Queries the Resource Groups Tagging API for resources tagged with
 * `managed-by=assignee-ai` and returns JSON matching `assignee admin list --json` output.
 *
 * @see Epic 20, ADR-008, Story 20.4
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchManagedResources } from "../services/list-resources.js";

export const listManagedResourcesParams = {
  region: z
    .string()
    .optional()
    .describe(
      "AWS region to query (e.g. 'us-east-1'). Defaults to configured region.",
    ),
  resourceType: z
    .string()
    .optional()
    .describe(
      "Filter by AWS resource type (e.g. 'AWS::S3::Bucket'). Returns all types if omitted.",
    ),
};

export function registerListManagedResources(server: McpServer): void {
  server.tool(
    "list_managed_resources",
    "List all AWS resources currently managed by assignee.ai. Returns resources tagged with managed-by=assignee-ai.",
    listManagedResourcesParams,
    async ({ region, resourceType }) => {
      try {
        const resources = await fetchManagedResources(region, resourceType);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                count: resources.length,
                resources,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Failed to list resources: ${err instanceof Error ? err.message : String(err)}`,
                hint: "Check that AWS credentials are configured and have resource-groups-tagging-api:GetResources permission.",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
