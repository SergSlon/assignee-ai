/**
 * Destroy strategy for AWS::SQS::Queue.
 *
 * SQS uses QueueUrl as the CloudControl primaryIdentifier, not the queue name.
 * The extractIdentifier hook constructs the URL from the ARN components.
 */

import type { DestroyStrategy } from "./types.js";

export const sqsStrategy: DestroyStrategy = {
  resourceType: "AWS::SQS::Queue",

  extractIdentifier(arn: string, _region: string): string {
    // arn:aws:sqs:us-east-1:123456789012:queue-name
    //   → https://sqs.us-east-1.amazonaws.com/123456789012/queue-name
    const parts = arn.split(":");
    const arnRegion = parts[3] || "us-east-1";
    const account = parts[4] || "";
    const queueName = parts[5] || "";
    return `https://sqs.${arnRegion}.amazonaws.com/${account}/${queueName}`;
  },
};
