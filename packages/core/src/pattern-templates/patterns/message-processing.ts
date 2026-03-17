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
      resourceType: "AWS::SQS::Queue",
      resourceId: "dlq",
      displayName: "Dead Letter Queue",
    },
    {
      resourceType: "AWS::SQS::Queue",
      resourceId: "main-queue",
      displayName: "Main Processing Queue",
    },
    {
      resourceType: "AWS::DynamoDB::Table",
      resourceId: "results-table",
      displayName: "Results DynamoDB Table",
    },
    {
      resourceType: "AWS::IAM::Role",
      resourceId: "lambda-role",
      displayName: "Lambda Execution Role",
    },
    {
      resourceType: "AWS::Lambda::Function",
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
    dlq: { MessageRetentionPeriod: 1209600 },
    "main-queue": {
      VisibilityTimeout: 180,
      MessageRetentionPeriod: 1209600,
      ReceiveMessageWaitTimeSeconds: 20,
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
