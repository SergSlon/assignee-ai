import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { markerGetAtt } from "../../config/marker-tokens.js";
import type { ArchitecturePattern } from "../types.js";
import { SqsWithDlqResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

export const sqsWithDlqPattern: ArchitecturePattern = {
  patternId: PatternId.SQS_WITH_DLQ,
  displayName: "SQS Queue with Dead-Letter Queue",
  keywords: [
    "with dlq",
    "with dead-letter queue",
    "with dead letter queue",
    "dead letter queue",
    "dead-letter queue",
    "with a dlq",
    "sqs dlq",
    "sqs with dlq",
    "queue with dlq",
    "queue and dlq",
    "sqs and dead letter",
    "sqs and dead-letter",
  ],
  negativeKeywords: [
    // Prevent collision with message-processing compound which already
    // has a DLQ as part of a larger Lambda pipeline
    "lambda",
    "processor",
    "message processing",
  ],
  resourceList: [
    {
      resourceType: RESOURCE_TYPES.SQS_QUEUE,
      resourceId: R.DLQ,
      displayName: "Dead Letter Queue",
    },
    {
      resourceType: RESOURCE_TYPES.SQS_QUEUE,
      resourceId: R.PRIMARY_QUEUE,
      displayName: "Primary Queue",
    },
  ],
  dependencyOrder: [
    // DLQ must exist before primary so its ARN can be wired into
    // the primary's RedrivePolicy.deadLetterTargetArn
    [R.DLQ],
    [R.PRIMARY_QUEUE],
  ],
  defaultOptions: {
    [R.DLQ]: {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    },
    [R.PRIMARY_QUEUE]: {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
      RedrivePolicy: {
        deadLetterTargetArn: markerGetAtt(R.DLQ, "Arn"),
        maxReceiveCount: 5,
      },
    },
  },
};
