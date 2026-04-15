/**
 * Resource resolution via Resource Groups Tagging API.
 *
 * Tag verification is mandatory — no ARN-bypass path exists. If RGTA cannot
 * prove managed-by=assignee-ai on the ARN, the destroy is refused.
 */

import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from "@aws-sdk/client-resource-groups-tagging-api";
import {
  AssigneeTag,
  isArn as coreIsArn,
  arnToResourceType as coreArnToResourceType,
  extractIdentifierFromArn as coreExtractIdentifierFromArn,
  extractRegionFromArn as coreExtractRegionFromArn,
} from "@assignee/core";
import { destroyRegistry } from "../../services/destroy-strategies/index.js";
import {
  MAX_RESOLVE_RETRIES,
  RESOLVE_RETRY_DELAY_MS,
  type ResolvedResource,
} from "./types.js";

const TAG_KEY_MANAGED_BY = AssigneeTag.KEY;
const TAG_VALUE_MANAGED_BY = AssigneeTag.VALUE;

export const isArn = coreIsArn;
export const arnToResourceType = coreArnToResourceType;
export const extractIdentifierFromArn = coreExtractIdentifierFromArn;
export const extractRegionFromArn = coreExtractRegionFromArn;

/**
 * Returns the correct CloudControl Identifier for a resource given its ARN and type.
 * Delegates to the destroy strategy registry for type-specific identifier resolution.
 */
export function getCloudControlIdentifier(
  arn: string,
  resourceType: string,
  extractedId: string,
  defaultRegion: string,
): string {
  const strategy = destroyRegistry.get(resourceType);
  if (strategy?.usesArnIdentifier) {
    return arn;
  }
  if (strategy?.extractIdentifier) {
    return strategy.extractIdentifier(
      arn,
      extractRegionFromArn(arn, defaultRegion),
    );
  }
  return extractedId;
}

/**
 * Some resource types (e.g., Route) have no ARN — they use composite
 * primaryIdentifiers like "rtb-xxx|0.0.0.0/0". Detect and handle these
 * directly without Tagging API resolution.
 */
export function tryResolveCompositeIdentifier(
  input: string,
  region: string,
): ResolvedResource | null {
  if (input.includes("|") && input.startsWith("rtb-")) {
    return {
      arn: input,
      resourceType: "AWS::EC2::Route",
      region,
      identifier: input,
    };
  }
  return null;
}

/** True iff the RGTA tag mapping carries the required managed-by tag. */
function hasManagedByTag(
  tags: Array<{ Key?: string; Value?: string }>,
): boolean {
  return tags.some(
    (t) => t.Key === TAG_KEY_MANAGED_BY && t.Value === TAG_VALUE_MANAGED_BY,
  );
}

/**
 * Targeted tag verification for a specific ARN. Uses the ResourceARNList
 * parameter so RGTA returns tags for that exact ARN (or an empty list if
 * it isn't indexed yet).
 */
export async function verifyArnIsManaged(
  arn: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RESOLVE_RETRIES; attempt++) {
    const response = await taggingClient.send(
      new GetResourcesCommand({ ResourceARNList: [arn] }),
    );
    for (const mapping of response.ResourceTagMappingList ?? []) {
      if (mapping.ResourceARN !== arn) continue;
      if (hasManagedByTag(mapping.Tags ?? [])) return true;
    }
    if (attempt < MAX_RESOLVE_RETRIES - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, RESOLVE_RETRY_DELAY_MS),
      );
    }
  }
  return false;
}

/**
 * Paginates the full managed resource set looking for a match by ARN or
 * by bare identifier. Used when the caller provided a non-ARN name.
 */
async function resolveByNameOrArn(
  input: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<ResolvedResource | null> {
  const inputIsArn = isArn(input);
  for (let attempt = 0; attempt < MAX_RESOLVE_RETRIES; attempt++) {
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
        if (!hasManagedByTag(mapping.Tags ?? [])) continue;

        const identifier = extractIdentifierFromArn(arn);
        const matchesArn = inputIsArn && arn === input;
        const matchesName = !inputIsArn && identifier === input;

        if (matchesArn || matchesName) {
          const resourceType = arnToResourceType(arn) ?? "Unknown";
          return {
            arn,
            resourceType,
            region: extractRegionFromArn(arn, region),
            identifier: getCloudControlIdentifier(
              arn,
              resourceType,
              identifier,
              region,
            ),
          };
        }
      }

      paginationToken = response.PaginationToken;
    } while (paginationToken);

    if (attempt < MAX_RESOLVE_RETRIES - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, RESOLVE_RETRY_DELAY_MS),
      );
    }
  }

  return null;
}

export async function resolveResource(
  input: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<ResolvedResource | null> {
  const composite = tryResolveCompositeIdentifier(input, region);
  if (composite) return composite;

  if (isArn(input)) {
    const isManaged = await verifyArnIsManaged(input, taggingClient);
    if (!isManaged) return null;
    const resourceType = arnToResourceType(input) ?? "Unknown";
    const identifier = extractIdentifierFromArn(input);
    return {
      arn: input,
      resourceType,
      region: extractRegionFromArn(input, region),
      identifier: getCloudControlIdentifier(
        input,
        resourceType,
        identifier,
        region,
      ),
    };
  }

  return resolveByNameOrArn(input, taggingClient, region);
}
