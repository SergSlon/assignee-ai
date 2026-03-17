import type { ArchitecturePattern } from "../types.js";

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
      resourceType: "AWS::IAM::Role",
      resourceId: "iam-execution-role",
      displayName: "Lambda Execution Role",
    },
    {
      resourceType: "AWS::Lambda::Function",
      resourceId: "lambda-fn",
      displayName: "Lambda Function",
    },
    {
      resourceType: "AWS::DynamoDB::Table",
      resourceId: "dynamodb-table",
      displayName: "DynamoDB Table",
    },
    {
      resourceType: "AWS::ApiGatewayV2::Api",
      resourceId: "api-gateway",
      displayName: "HTTP API Gateway",
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
