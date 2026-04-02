import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { AwsDefault } from "../../config/cfn-keys.js";
import { IamEffect } from "../../config/iam-effects.js";
import type { ArchitecturePattern } from "../types.js";
import { MessageProcessingResourceId as R } from "../pattern-resource-ids.js";

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
      resourceId: R.DLQ,
      displayName: "Dead Letter Queue",
    },
    {
      resourceType: RESOURCE_TYPES.SQS_QUEUE,
      resourceId: R.MAIN_QUEUE,
      displayName: "Main Processing Queue",
    },
    {
      resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
      resourceId: R.RESULTS_TABLE,
      displayName: "Results DynamoDB Table",
    },
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: R.LAMBDA_ROLE,
      displayName: "Lambda Execution Role",
    },
    {
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      resourceId: R.PROCESSOR_FN,
      displayName: "Message Processor Lambda",
    },
  ],
  dependencyOrder: [
    [R.DLQ],
    [R.MAIN_QUEUE, R.RESULTS_TABLE, R.LAMBDA_ROLE],
    [R.PROCESSOR_FN],
  ],
  defaultOptions: {
    [R.DLQ]: {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    },
    [R.MAIN_QUEUE]: {
      VisibilityTimeout: 180,
      MessageRetentionPeriod: 1209600,
      ReceiveMessageWaitTimeSeconds: 20,
      SqsManagedSseEnabled: true,
    },
    [R.RESULTS_TABLE]: {
      BillingMode: AwsDefault.BILLING_PAY_PER_REQUEST,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      KeySchema: [{ AttributeName: "messageId", KeyType: "HASH" }],
      AttributeDefinitions: [
        { AttributeName: "messageId", AttributeType: "S" },
      ],
    },
    [R.LAMBDA_ROLE]: {
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: IamEffect.ALLOW,
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
      ManagedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ],
    },
    [R.PROCESSOR_FN]: {
      Runtime: AwsDefault.LAMBDA_RUNTIME,
      Handler: AwsDefault.LAMBDA_HANDLER,
      MemorySize: 512,
      Timeout: 180,
      Architectures: [AwsDefault.ARCH_ARM],
      Code: {
        ZipFile:
          "exports.handler = async (event) => ({ statusCode: 200, body: JSON.stringify({ processed: event.Records?.length ?? 0 }) });",
      },
    },
  },
};
