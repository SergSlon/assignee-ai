/**
 * Shared types and helpers for the resource-resolver pipeline.
 *
 * @see Story 18.5
 */

import type { ResourceTagMapping } from "@aws-sdk/client-resource-groups-tagging-api";

/** Resolved resource returned by the resource resolver. */
export interface ResolvedResource {
  arn: string;
  resourceType: string;
  region: string;
  tags: Record<string, string>;
  identifier: string;
}

/**
 * Converts a ResourceTagMapping's tag list to a flat key-value record.
 */
export function tagsToRecord(
  mapping: ResourceTagMapping,
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of mapping.Tags ?? []) {
    if (tag.Key && tag.Value !== undefined) {
      tags[tag.Key] = tag.Value;
    }
  }
  return tags;
}
