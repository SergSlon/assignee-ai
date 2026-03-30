import { RESOURCE_TYPES, COMPANION_RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ArchitecturePattern } from "../types.js";

/** Shorthand aliases for companion resource type constants used in this pattern. */
const APIGATEWAYV2_INTEGRATION = COMPANION_RESOURCE_TYPES.APIGATEWAYV2_INTEGRATION;
const APIGATEWAYV2_ROUTE = COMPANION_RESOURCE_TYPES.APIGATEWAYV2_ROUTE;
const APIGATEWAYV2_STAGE = COMPANION_RESOURCE_TYPES.APIGATEWAYV2_STAGE;
const LAMBDA_PERMISSION = COMPANION_RESOURCE_TYPES.LAMBDA_PERMISSION;

/**
 * Full Serverless API compound pattern.
 * Produces a complete serverless API with 8 resources:
 *
 * 1. IAM Role — Lambda execution role with trust policy for lambda.amazonaws.com
 * 2. Lambda Function — the API handler function, linked to IAM Role
 * 3. CloudWatch LogGroup — for API Gateway access logs
 * 4. API Gateway V2 Api — HTTP API with CORS configuration
 * 5. API Gateway V2 Integration — Lambda proxy integration
 * 6. API Gateway V2 Route — default route ($default) with integration
 * 7. API Gateway V2 Stage — $default stage with access logging to LogGroup
 * 8. Lambda Permission — grants API Gateway invoke permission on Lambda
 *
 * Cross-references:
 * - Lambda -> IAM Role ARN (via Fn::GetAtt)
 * - Integration -> Lambda ARN (via Fn::GetAtt) + API ID (via Ref)
 * - Route -> Integration ID (via Fn::GetAtt) + API ID (via Ref)
 * - Stage -> LogGroup ARN (via Fn::GetAtt) + API ID (via Ref)
 * - Permission -> API ID (via Ref) + Lambda ARN (via Fn::GetAtt)
 *
 * @see Story 26.4 — Serverless API Compound Pattern
 */
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
    "create a serverless api",
    "create an api",
    "build an http api",
    "serverless rest api",
  ],
  resourceList: [
    // 1. IAM Role (no dependencies)
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: "iam-execution-role",
      displayName: "Lambda Execution Role",
    },
    // 2. Lambda Function (depends on Role)
    {
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      resourceId: "lambda-fn",
      displayName: "Lambda Function",
    },
    // 3. CloudWatch LogGroup (no dependencies, logically grouped after Lambda)
    {
      resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
      resourceId: "access-log-group",
      displayName: "API Gateway Access LogGroup",
    },
    // 4. API Gateway V2 Api (no dependencies)
    {
      resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
      resourceId: "http-api",
      displayName: "HTTP API Gateway",
      provisionable: false,
    },
    // 5. Integration (depends on API + Lambda)
    {
      resourceType: APIGATEWAYV2_INTEGRATION,
      resourceId: "lambda-integration",
      displayName: "Lambda Proxy Integration",
      provisionable: false,
    },
    // 6. Route (depends on API + Integration)
    {
      resourceType: APIGATEWAYV2_ROUTE,
      resourceId: "default-route",
      displayName: "Default Route ($default)",
      provisionable: false,
    },
    // 7. Stage (depends on API + LogGroup)
    {
      resourceType: APIGATEWAYV2_STAGE,
      resourceId: "default-stage",
      displayName: "$default Stage",
      provisionable: false,
    },
    // 8. Lambda Permission (depends on API + Lambda)
    {
      resourceType: LAMBDA_PERMISSION,
      resourceId: "api-invoke-permission",
      displayName: "API Gateway → Lambda Permission",
      provisionable: false,
    },
  ],
  dependencyOrder: [
    // Group 0: IAM Role first — Lambda depends on it
    ["iam-execution-role"],
    // Group 1: Lambda + LogGroup + API — can be created in parallel
    ["lambda-fn", "access-log-group", "http-api"],
    // Group 2: Integration — needs API + Lambda
    ["lambda-integration"],
    // Group 3: Route + Stage + Permission — need API + Integration/LogGroup/Lambda
    ["default-route", "default-stage", "api-invoke-permission"],
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
      PermissionsBoundary: "arn:aws:iam::aws:policy/PowerUserAccess",
    },
    "lambda-fn": {
      Runtime: "nodejs22.x",
      MemorySize: 512,
      Timeout: 30,
      Architectures: ["arm64"],
      Role: { "Fn::GetAtt": ["iam-execution-role", "Arn"] },
    },
    "access-log-group": {
      LogGroupName: "/aws/apigateway/serverless-api",
      RetentionInDays: 14,
    },
    "http-api": {
      ProtocolType: "HTTP",
      CorsConfiguration: {
        AllowOrigins: ["*"],
        AllowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        AllowHeaders: ["Content-Type", "Authorization"],
      },
    },
    "lambda-integration": {
      ApiId: { Ref: "http-api" },
      IntegrationType: "AWS_PROXY",
      IntegrationUri: { "Fn::GetAtt": ["lambda-fn", "Arn"] },
      PayloadFormatVersion: "2.0",
    },
    "default-route": {
      ApiId: { Ref: "http-api" },
      RouteKey: "$default",
      Target: {
        "Fn::Join": ["/", ["integrations", { Ref: "lambda-integration" }]],
      },
    },
    "default-stage": {
      ApiId: { Ref: "http-api" },
      StageName: "$default",
      AutoDeploy: true,
      AccessLogSettings: {
        DestinationArn: { "Fn::GetAtt": ["access-log-group", "Arn"] },
      },
    },
    "api-invoke-permission": {
      Action: "lambda:InvokeFunction",
      FunctionName: { "Fn::GetAtt": ["lambda-fn", "Arn"] },
      Principal: "apigateway.amazonaws.com",
      SourceArn: {
        "Fn::Sub":
          "arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${http-api}/*",
      },
    },
  },
};
