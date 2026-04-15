/**
 * SQS queue URL lookup strategy.
 *
 * The queue URL IS the CloudControl identifier for AWS::SQS::Queue.
 * Searches managed resources for a matching SQS queue name, then returns
 * the resolved resource with the queue URL as the identifier.
 *
 * @see Story 18.5
 */

import {
  GetResourcesCommand,
  type ResourceGroupsTaggingAPIClient,
} from "@aws-sdk/client-resource-groups-tagging-api";
import { RESOURCE_TYPES, isArnOfService } from "@assignee/core";
import { TAG_KEY_MANAGED_BY, TAG_VALUE_MANAGED_BY } from "../../utils/tags.js";
import { parseSqsQueueUrl } from "./sqs-url.js";
import { tagsToRecord, type ResolvedResource } from "./types.js";

/**
 * Resolves an SQS queue by its queue URL.
 */
export async function resolveSqsQueueUrl(
  queueUrl: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  defaultRegion: string,
): Promise<ResolvedResource[]> {
  const parsed = parseSqsQueueUrl(queueUrl);
  if (!parsed) return [];

  const matches: ResolvedResource[] = [];

  // Search managed resources for an SQS queue with a matching name.
  // Story 48.6: full pagination; caller decides 0/1/≥2 semantics.
  // Realistically always 0 or 1, but keep the signature uniform so the
  // disambiguator's union-narrowing stays clean.
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

      // Match SQS ARN across all partitions (aws, aws-us-gov, aws-cn, aws-iso*).
      // ARN shape: arn:<partition>:sqs:{region}:{account}:{queue-name}
      if (isArnOfService(arn, "sqs") && arn.endsWith(":" + parsed.queueName)) {
        matches.push({
          arn,
          resourceType: RESOURCE_TYPES.SQS_QUEUE,
          region: parsed.region || defaultRegion,
          tags: tagsToRecord(mapping),
          identifier: queueUrl, // CloudControl identifier for SQS is the queue URL
        });
      }
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return matches;
}
