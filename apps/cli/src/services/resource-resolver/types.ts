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
 * Multi-match resolution: caller MUST disambiguate before proceeding.
 *
 * Produced when a by-name or by-SQS-URL lookup finds ≥2 managed resources
 * matching the user's input. The caller (destroy single-flow) either
 * prompts the user to pick one (interactive) or fails fast with an
 * actionable error (--yes / non-TTY), per Story 48.6.
 */
export interface AmbiguousResolution {
  readonly kind: "ambiguous";
  readonly input: string;
  readonly matches: readonly ResolvedResource[];
}

/** Discriminated-union result of resolveResource. */
export type Resolution = ResolvedResource | AmbiguousResolution | null;

/** Type-guard: AmbiguousResolution discriminator check. */
export function isAmbiguousResolution(
  value: Resolution,
): value is AmbiguousResolution {
  return value !== null && "kind" in value && value.kind === "ambiguous";
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
