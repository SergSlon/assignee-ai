/**
 * Disambiguator / strategy router for the resource-resolver.
 *
 * Chooses between lookup-by-arn, lookup-by-sqs-url, and lookup-by-name
 * based on the shape of the input string. Strategies share the common
 * signature `(input, client, region) => Promise<ResolvedResource | null>`.
 *
 * @see Story 18.5
 */

import type { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { isArn } from "@assignee/core";
import { resolveByArn } from "./lookup-by-arn.js";
import { resolveByName } from "./lookup-by-name.js";
import { resolveSqsQueueUrl } from "./lookup-by-sqs-url.js";
import { isSqsQueueUrl } from "./sqs-url.js";
import type {
  AmbiguousResolution,
  Resolution,
  ResolvedResource,
} from "./types.js";

/**
 * Collapses a match array into the union: 0 → null, 1 → single,
 * ≥2 → AmbiguousResolution. Story 48.6.
 */
function collapseMatches(
  input: string,
  matches: ResolvedResource[],
): ResolvedResource | AmbiguousResolution | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;
  return { kind: "ambiguous", input, matches };
}

/**
 * Resolves a resource by ARN or name using the Resource Groups Tagging API.
 * Only returns resources tagged with managed-by=assignee-ai.
 *
 * Story 48.6: returns a discriminated union — `ResolvedResource | null`
 * for ARN lookups (unique by construction) and for single-match name /
 * SQS-URL lookups, or `AmbiguousResolution` when a name / SQS-URL path
 * produced ≥2 matches. Callers MUST narrow on the `kind` field before
 * acting on a multi-match.
 *
 * @param input - Resource ARN or name
 * @param taggingClient - Pre-configured ResourceGroupsTaggingAPIClient
 * @param region - Default AWS region
 * @returns Resolution: null (not found), ResolvedResource (one match),
 *          or AmbiguousResolution (≥2 matches)
 */
export async function resolveResource(
  input: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<Resolution> {
  if (isArn(input)) {
    return resolveByArn(input, taggingClient, region);
  }

  // SQS queue URLs: the CloudControl identifier for AWS::SQS::Queue IS the queue URL.
  // Resolve by extracting the queue name and searching managed resources.
  if (isSqsQueueUrl(input)) {
    const sqsMatches = await resolveSqsQueueUrl(input, taggingClient, region);
    return collapseMatches(input, sqsMatches);
  }

  const nameMatches = await resolveByName(input, taggingClient, region);
  return collapseMatches(input, nameMatches);
}
