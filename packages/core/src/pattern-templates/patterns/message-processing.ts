import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { AwsDefault } from "../../config/cfn-keys.js";
import { IamEffect } from "../../config/iam-effects.js";
import {
  AwsManagedPolicy,
  awsManagedPolicyArn,
  IamPolicy,
  AwsServicePrincipal,
} from "../../config/aws-arns.js";
import type { ArchitecturePattern } from "../types.js";
import { MessageProcessingResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

export const messageProcessingPattern: ArchitecturePattern = {
  patternId: PatternId.MESSAGE_PROCESSING,
  displayName: "Message Processing Pipeline",
  keywords: [
    "message processing",
    "sqs lambda",
    "queue processor",
    "event-driven",
    "async processing pipeline",
    "message queue with lambda",
    // CP-4 probe D: "Lambda that processes SQS messages" phrasing
    "processes sqs",
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
        Version: IamPolicy.VERSION,
        Statement: [
          {
            Effect: IamEffect.ALLOW,
            Principal: { Service: AwsServicePrincipal.LAMBDA },
            Action: IamPolicy.ACTION_ASSUME_ROLE,
          },
        ],
      },
      // Commercial-partition ARN; rewriteManagedPolicyArnsForPartition() in
      // compound-plan.ts rewrites this to the correct partition at apply time.
      ManagedPolicyArns: [
        awsManagedPolicyArn(
          "aws",
          AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
        ),
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
