/**
 * Destroy strategy for AWS::SQS::Queue.
 *
 * SQS uses QueueUrl as the CloudControl primaryIdentifier, not the
 * queue name. The extractIdentifier hook constructs the URL from the
 * ARN components.
 *
 * @see Story 49.1 — migrated to the shared DestroyContext interface.
 */

import {
  RESOURCE_TYPES,
  DEFAULT_AWS_REGION,
  type DestroyStrategy,
} from "@assignee/core";

export const sqsStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.SQS_QUEUE,

  extractIdentifier(arn: string, _identifier: string, _region: string): string {
    // arn:aws:sqs:us-east-1:123456789012:queue-name
    //   → https://sqs.us-east-1.amazonaws.com/123456789012/queue-name
    const parts = arn.split(":");
    const arnRegion = parts[3] || DEFAULT_AWS_REGION;
    const account = parts[4] || "";
    const queueName = parts[5] || "";
    return `https://sqs.${arnRegion}.amazonaws.com/${account}/${queueName}`;
  },
};
