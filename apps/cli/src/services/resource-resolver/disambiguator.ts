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
import type { ResolvedResource } from "./types.js";

/**
 * Resolves a resource by ARN or name using the Resource Groups Tagging API.
 * Only returns resources tagged with managed-by=assignee-ai.
 *
 * @param input - Resource ARN or name
 * @param taggingClient - Pre-configured ResourceGroupsTaggingAPIClient
 * @param region - Default AWS region
 * @returns ResolvedResource or null if not found / not managed
 */
export async function resolveResource(
  input: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<ResolvedResource | null> {
  if (isArn(input)) {
    return resolveByArn(input, taggingClient, region);
  }

  // SQS queue URLs: the CloudControl identifier for AWS::SQS::Queue IS the queue URL.
  // Resolve by extracting the queue name and searching managed resources.
  if (isSqsQueueUrl(input)) {
    return resolveSqsQueueUrl(input, taggingClient, region);
  }

  return resolveByName(input, taggingClient, region);
}
