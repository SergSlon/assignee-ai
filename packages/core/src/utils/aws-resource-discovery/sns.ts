/**
 * SNS resource discovery: topics.
 */

import { ListTopicsCommand } from "@aws-sdk/client-sns";
import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createSnsClient } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

/**
 * Discovers SNS topics from the account.
 * Extracts a friendly name from the ARN's final segment.
 * ListTopics returns up to 100 per page; we fetch one page (sufficient for
 * wizard UX — very large accounts with hundreds of topics rarely pick from
 * a list anyway and can fall back to manual entry).
 */
export async function discoverSnsTopics(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.SNS_TOPICS, async () => {
    const sns = createSnsClient();
    if (!sns) return []; // Graceful no-op: reader creds not configured
    const result = await withTimeout(
      sns.send(new ListTopicsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    if (!result?.Topics) return [];

    return result.Topics.map((topic) => {
      const arn = topic.TopicArn ?? "";
      // Extract the topic name from the ARN: arn:aws:sns:region:account:topic-name
      const topicName = arn.split(":").pop() ?? arn;
      const label = topicName ? `${topicName} — ${arn}` : arn;
      return { value: arn, label };
    }).filter((o) => o.value);
  });
}
