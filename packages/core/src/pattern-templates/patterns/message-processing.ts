import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ArchitecturePattern } from "../types.js";

export const messageProcessingPattern: ArchitecturePattern = {
  patternId: "message-processing",
  displayName: "Message Processing Pipeline",
  keywords: [
    "message processing",
    "sqs lambda",
    "queue processor",
    "event-driven",
    "async processing pipeline",
    "message queue with lambda",
  ],
  resourceList: [
    {
      resourceType: RESOURCE_TYPES.SQS_QUEUE,
      resourceId: "dlq",
      displayName: "Dead Letter Queue",
    },
    {
      resourceType: RESOURCE_TYPES.SQS_QUEUE,
      resourceId: "main-queue",
      displayName: "Main Processing Queue",
    },
    {
      resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
      resourceId: "results-table",
      displayName: "Results DynamoDB Table",
    },
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: "lambda-role",
      displayName: "Lambda Execution Role",
    },
    {
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      resourceId: "processor-fn",
      displayName: "Message Processor Lambda",
    },
  ],
  dependencyOrder: [
    ["dlq"],
    ["main-queue", "results-table", "lambda-role"],
    ["processor-fn"],
  ],
  defaultOptions: {
    dlq: {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    },
    "main-queue": {
      VisibilityTimeout: 180,
      MessageRetentionPeriod: 1209600,
      ReceiveMessageWaitTimeSeconds: 20,
      SqsManagedSseEnabled: true,
    },
    "results-table": {
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    },
    "processor-fn": {
      Runtime: "nodejs22.x",
      MemorySize: 512,
      Timeout: 180,
      Architectures: ["arm64"],
    },
  },
};
