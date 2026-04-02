import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "../../config/resource-types.js";
import { AwsDefault } from "../../config/cfn-keys.js";
import { IamEffect } from "../../config/iam-effects.js";
import { AwsManagedPolicy } from "../../config/aws-arns.js";
import type { ArchitecturePattern } from "../types.js";
import { ServerlessApiResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

/** Shorthand aliases for companion resource type constants used in this pattern. */
const APIGATEWAYV2_INTEGRATION =
  COMPANION_RESOURCE_TYPES.APIGATEWAYV2_INTEGRATION;
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
  patternId: PatternId.SERVERLESS_API,
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
      resourceId: R.IAM_EXECUTION_ROLE,
      displayName: "Lambda Execution Role",
    },
    // 2. Lambda Function (depends on Role)
    {
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      resourceId: R.LAMBDA_FN,
      displayName: "Lambda Function",
    },
    // 3. CloudWatch LogGroup (no dependencies, logically grouped after Lambda)
    {
      resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
      resourceId: R.ACCESS_LOG_GROUP,
      displayName: "API Gateway Access LogGroup",
    },
    // 4. API Gateway V2 Api (no dependencies)
    {
      resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
      resourceId: R.HTTP_API,
      displayName: "HTTP API Gateway",
      provisionable: false,
    },
    // 5. Integration (depends on API + Lambda)
    {
      resourceType: APIGATEWAYV2_INTEGRATION,
      resourceId: R.LAMBDA_INTEGRATION,
      displayName: "Lambda Proxy Integration",
      provisionable: false,
    },
    // 6. Route (depends on API + Integration)
    {
      resourceType: APIGATEWAYV2_ROUTE,
      resourceId: R.DEFAULT_ROUTE,
      displayName: "Default Route ($default)",
      provisionable: false,
    },
    // 7. Stage (depends on API + LogGroup)
    {
      resourceType: APIGATEWAYV2_STAGE,
      resourceId: R.DEFAULT_STAGE,
      displayName: "$default Stage",
      provisionable: false,
    },
    // 8. Lambda Permission (depends on API + Lambda)
    {
      resourceType: LAMBDA_PERMISSION,
      resourceId: R.API_INVOKE_PERMISSION,
      displayName: "API Gateway → Lambda Permission",
      provisionable: false,
    },
  ],
  dependencyOrder: [
    // Group 0: IAM Role first — Lambda depends on it
    [R.IAM_EXECUTION_ROLE],
    // Group 1: Lambda + LogGroup + API — can be created in parallel
    [R.LAMBDA_FN, R.ACCESS_LOG_GROUP, R.HTTP_API],
    // Group 2: Integration — needs API + Lambda
    [R.LAMBDA_INTEGRATION],
    // Group 3: Route + Stage + Permission — need API + Integration/LogGroup/Lambda
    [R.DEFAULT_ROUTE, R.DEFAULT_STAGE, R.API_INVOKE_PERMISSION],
  ],
  defaultOptions: {
    [R.IAM_EXECUTION_ROLE]: {
      Path: "/",
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
      PermissionsBoundary: AwsManagedPolicy.POWER_USER_ACCESS,
    },
    [R.LAMBDA_FN]: {
      Runtime: AwsDefault.LAMBDA_RUNTIME,
      MemorySize: 512,
      Timeout: 30,
      Architectures: [AwsDefault.ARCH_ARM],
      Role: { "Fn::GetAtt": [R.IAM_EXECUTION_ROLE, "Arn"] },
    },
    [R.ACCESS_LOG_GROUP]: {
      LogGroupName: "/aws/apigateway/serverless-api",
      RetentionInDays: 14,
    },
    [R.HTTP_API]: {
      ProtocolType: AwsDefault.PROTOCOL_HTTP,
      CorsConfiguration: {
        // SECURITY: Configure AllowOrigins for your specific domain(s).
        // Example: ["https://example.com", "https://app.example.com"]
        AllowOrigins: [] as string[],
        AllowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        AllowHeaders: ["Content-Type", "Authorization"],
      },
    },
    [R.LAMBDA_INTEGRATION]: {
      ApiId: { Ref: R.HTTP_API },
      IntegrationType: "AWS_PROXY",
      IntegrationUri: { "Fn::GetAtt": [R.LAMBDA_FN, "Arn"] },
      PayloadFormatVersion: "2.0",
    },
    [R.DEFAULT_ROUTE]: {
      ApiId: { Ref: R.HTTP_API },
      RouteKey: "$default",
      Target: {
        "Fn::Join": ["/", ["integrations", { Ref: R.LAMBDA_INTEGRATION }]],
      },
    },
    [R.DEFAULT_STAGE]: {
      ApiId: { Ref: R.HTTP_API },
      StageName: "$default",
      AutoDeploy: true,
      AccessLogSettings: {
        DestinationArn: { "Fn::GetAtt": [R.ACCESS_LOG_GROUP, "Arn"] },
      },
    },
    [R.API_INVOKE_PERMISSION]: {
      Action: "lambda:InvokeFunction",
      FunctionName: { "Fn::GetAtt": [R.LAMBDA_FN, "Arn"] },
      Principal: "apigateway.amazonaws.com",
      SourceArn: {
        "Fn::Sub": `arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${${R.HTTP_API}}/*`,
      },
    },
  },
};
