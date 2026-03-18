import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ArchitecturePattern } from "../types.js";

/**
 * AWS::ApiGatewayV2::Api — display-only in this pattern.
 * Not in RESOURCE_TYPES (CCAPI provisioning deferred; requires route/integration config from user).
 * provisionable: false prevents Story 8.2 compound-dispatcher from attempting CloudControl creation.
 */
const APIGATEWAYV2_API = "AWS::ApiGatewayV2::Api" as const;

export const serverlessApiPattern: ArchitecturePattern = {
  patternId: "serverless-api",
  displayName: "Serverless API",
  keywords: [
    "serverless api",
    "rest api with lambda",
    "lambda function with api",
    "api gateway",
    "serverless backend",
    "http api lambda",
  ],
  resourceList: [
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: "iam-execution-role",
      displayName: "Lambda Execution Role",
    },
    {
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      resourceId: "lambda-fn",
      displayName: "Lambda Function",
    },
    {
      resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
      resourceId: "dynamodb-table",
      displayName: "DynamoDB Table",
    },
    {
      resourceType: APIGATEWAYV2_API,
      resourceId: "api-gateway",
      displayName: "HTTP API Gateway",
      provisionable: false,
    },
  ],
  dependencyOrder: [
    ["iam-execution-role"],
    ["lambda-fn", "dynamodb-table"],
    ["api-gateway"],
  ],
  defaultOptions: {
    "iam-execution-role": {
      Path: "/",
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
    },
    "lambda-fn": {
      Runtime: "nodejs22.x",
      MemorySize: 512,
      Timeout: 30,
      Architectures: ["arm64"],
    },
    "dynamodb-table": {
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    },
    "api-gateway": {
      ProtocolType: "HTTP",
      CorsConfiguration: {
        AllowOrigins: ["*"],
        AllowMethods: ["GET", "POST", "PUT", "DELETE"],
        AllowHeaders: ["Content-Type", "Authorization"],
      },
    },
  },
};
