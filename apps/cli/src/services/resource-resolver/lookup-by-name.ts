/**
 * Name-based lookup strategy.
 *
 * Wave 10 P1-5: previously walked iam:ListRoles + iam:ListRoleTags
 * UNCONDITIONALLY before scanning RGTA, which added ~200 AWS API calls
 * to every `assignee destroy <name>` even when the user named a non-IAM
 * resource. RGTA is scanned first now; the IAM fallback only fires when
 * RGTA produced no match.
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
import { fetchManagedIamRoles } from "../iam-role-inventory.js";
import { matchesName } from "./name-matcher.js";
import { tagsToRecord, type ResolvedResource } from "./types.js";

/**
 * Resolves a resource by name — searches all managed resources for a
 * matching identifier.
 *
 * Story 48.6: returns ALL matches (not just the first). Callers decide
 * 0/1/≥2 semantics — the resolver no longer silently first-picks when
 * a name is ambiguous. RGTA pagination now runs to completion so every
 * page is scanned; the IAM-role fallback still only fires when RGTA
 * returned zero matches (preserves the Wave 10 P1-5 perf fix).
 */
export async function resolveByName(
  name: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  defaultRegion: string,
): Promise<ResolvedResource[]> {
  const matches: ResolvedResource[] = [];

  // ── Phase 1: scan RGTA first (covers every non-IAM-Role type) ────
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

      if (matchesName(arn, name)) {
        const resourceType = arnToResourceType(arn);
        matches.push({
          arn,
          resourceType: resourceType ?? "Unknown",
          region: extractRegionFromArn(arn, defaultRegion),
          tags: tagsToRecord(mapping),
          identifier: getCloudControlIdentifier(arn, resourceType),
        });
      }
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  if (matches.length > 0) return matches;

  // ── Phase 2: IAM::Role fallback (RGTA doesn't return IAM roles) ──
  // Only walk iam:ListRoles when RGTA found nothing — this preserves
  // IAM byName resolution while removing the perf regression for the
  // 99% of byName destroys that target non-IAM resources.
  try {
    const iamRoles = await fetchManagedIamRoles();
    for (const role of iamRoles) {
      if (role.roleName === name || role.arn === name) {
        matches.push({
          arn: role.arn,
          resourceType: RESOURCE_TYPES.IAM_ROLE,
          region: defaultRegion,
          tags: role.tags,
          identifier: role.roleName,
        });
      }
    }
  } catch {
    // Non-fatal: caller treats [] as "not found". The list command
    // emits a clearer warning when iam:ListRoles is missing.
  }

  return matches;
}
