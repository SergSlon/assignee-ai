/**
 * CLI-side wrapper around `@assignee/core`'s `fetchManagedResources`.
 *
 * The core module is transport-agnostic and SDK-decoupled (Story 52-2);
 * this wrapper owns the RGTA client construction and injects the
 * CLI-specific enrichers: `fetchManagedIamRoles` (IAM::Role gap) and
 * `fetchBillingData` (Billing MCP live costs).
 *
 * @see Story 18.4, Story 19.7, Story 49.2, Story 52-2
 */

import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
  type GetResourcesOutput,
} from "@aws-sdk/client-resource-groups-tagging-api";
import type { StructuredTool } from "@langchain/core/tools";
import {
  defaultMemoryService,
  fetchManagedResources as coreFetchManagedResources,
  type ManagedResource,
  type RgtaMapping,
} from "@assignee/core";
import { AWS_REGION } from "../config/constants.js";
import { tryAssigneeCredentials } from "../config/aws-credentials.js";
import { TAG_KEY_MANAGED_BY, TAG_VALUE_MANAGED_BY } from "../utils/tags.js";
import { fetchBillingData } from "./billing.js";
import { fetchManagedIamRoles } from "./iam-role-inventory.js";
import {
  createListPricingEnricher,
  createListCreatedDateEnricher,
} from "@assignee/core";

// Re-export for consumers that import from this module.
export { arnToCloudFormationType, parseArn } from "@assignee/core";
export type { ManagedResource } from "@assignee/core";

/**
 * Fetches all resources tagged with `managed-by=assignee-ai` from AWS,
 * enriched with IAM-role + provision-log + billing data.
 *
 * Parity with MCP `list_managed_resources` tool (see
 * `apps/mcp-server/src/tools/list-managed-resources.ts`): positional
 * argument order is `(region?, resourceType?, mcpTools?)` so the CLI
 * `list` / `status` commands can forward the same filter the MCP tool
 * exposes. Story 56-it1-01.
 */
export async function fetchManagedResources(
  region?: string,
  resourceType?: string,
  mcpTools?: StructuredTool[],
): Promise<ManagedResource[]> {
  const resolvedRegion = region ?? AWS_REGION;
  const opCreds = tryAssigneeCredentials("operator");
  const client = new ResourceGroupsTaggingAPIClient({
    region: resolvedRegion,
    ...(opCreds
      ? {
          credentials: {
            accessKeyId: opCreds.accessKeyId,
            secretAccessKey: opCreds.secretAccessKey,
            // W2-01: pass session token for STS/SSO short-term credentials.
            ...(opCreds.sessionToken
              ? { sessionToken: opCreds.sessionToken }
              : {}),
          },
        }
      : {}),
  });

  const fetchRgtaResources = async (): Promise<RgtaMapping[]> => {
    const all: RgtaMapping[] = [];
    let paginationToken: string | undefined;
    do {
      const command = new GetResourcesCommand({
        TagFilters: [
          { Key: TAG_KEY_MANAGED_BY, Values: [TAG_VALUE_MANAGED_BY] },
        ],
        ...(paginationToken ? { PaginationToken: paginationToken } : {}),
      });
      const response: GetResourcesOutput = await client.send(command);
      for (const m of response.ResourceTagMappingList ?? []) all.push(m);
      paginationToken = response.PaginationToken;
    } while (paginationToken);
    return all;
  };

  // Build credentials object for SDK-based enrichers (created-date, etc.).
  // `opCreds` is already resolved above for the RGTA client — reuse it.
  const sdkCredentials = opCreds
    ? {
        accessKeyId: opCreds.accessKeyId,
        secretAccessKey: opCreds.secretAccessKey,
        ...(opCreds.sessionToken ? { sessionToken: opCreds.sessionToken } : {}),
      }
    : undefined;

  return coreFetchManagedResources({
    region: resolvedRegion,
    fetchRgtaResources,
    enrichWithIamRoles: () => fetchManagedIamRoles(),
    ...(resourceType ? { resourceTypeFilter: resourceType } : {}),
    ...(mcpTools && mcpTools.length > 0
      ? {
          enrichWithBilling: async (resources) =>
            (await fetchBillingData(resources, mcpTools)) as Map<
              string,
              { actualMonthlyCost: string }
            >,
        }
      : {}),
    // Pricing-MCP enrichment: resolves rate-card costs for N/A rows.
    enrichWithPricing: createListPricingEnricher(),
    // Created-date enrichment: resolves creation timestamps for N/A rows.
    ...(sdkCredentials
      ? {
          enrichWithCreatedDate: createListCreatedDateEnricher(
            sdkCredentials,
            resolvedRegion,
          ),
        }
      : {}),
    createdDateFallback: "na",
    useFreeTierFallback: true,
    getDestroyedArns: () => defaultMemoryService.readDestroyedArns(),
  });
}
