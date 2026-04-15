/**
 * ARN-based lookup strategy.
 *
 * Two paths:
 *   1. IAM::Role ARNs: Resource Groups Tagging API does NOT return IAM
 *      roles, so we fall through to `iam:GetRole` + `iam:ListRoleTags`.
 *   2. Everything else: paginated RGTA query with a `managed-by=assignee-ai`
 *      tag filter.
 *
 * @see Story 18.5
 */

import {
  GetResourcesCommand,
  type ResourceGroupsTaggingAPIClient,
} from "@aws-sdk/client-resource-groups-tagging-api";
import {
  RESOURCE_TYPES,
  arnToResourceType,
  extractRegionFromArn,
  getCloudControlIdentifier,
} from "@assignee/core";
import { TAG_KEY_MANAGED_BY, TAG_VALUE_MANAGED_BY } from "../../utils/tags.js";
import { getManagedIamRoleByArn } from "../iam-role-inventory.js";
import { tagsToRecord, type ResolvedResource } from "./types.js";

/**
 * Resolves a resource by ARN — validates it exists and is managed by assignee.ai.
 */
export async function resolveByArn(
  arn: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  defaultRegion: string,
): Promise<ResolvedResource | null> {
  // IAM::Role: Resource Groups Tagging API does NOT return roles, so
  // fall through to a direct iam:GetRole + iam:ListRoleTags lookup
  // before scanning RGTA. See iam-role-inventory.ts. Partition-aware
  // pattern (matches aws / aws-us-gov / aws-cn) so GovCloud and China
  // users can resolve IAM role ARNs the same way commercial users can.
  if (/^arn:aws[\w-]*:iam::\d+:role\//.test(arn)) {
    const role = await getManagedIamRoleByArn(arn);
    if (role) {
      return {
        arn: role.arn,
        resourceType: RESOURCE_TYPES.IAM_ROLE,
        region: defaultRegion,
        tags: role.tags,
        identifier: role.roleName,
      };
    }
    return null;
  }

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
