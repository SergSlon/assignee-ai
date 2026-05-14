import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "../../config/resource-types.js";
import { AwsDefault } from "../../config/cfn-keys.js";
import { markerGetAtt, markerRef } from "../../config/marker-tokens.js";
import { IamEffect } from "../../config/iam-effects.js";
import {
  AwsManagedPolicy,
  awsManagedPolicyArn,
  IamPolicy,
  AwsServicePrincipal,
} from "../../config/aws-arns.js";
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
 * Cross-references (expressed via marker tokens — CloudControl does not
 * process CloudFormation intrinsics, so `defaultOptions` never contains
 * Fn::GetAtt / Ref objects; the plan-generator substitutes markers with
 * physical identifiers from `completedResources` at apply time):
 * - Lambda -> IAM Role ARN (via markerGetAtt)
 * - Integration -> Lambda ARN (markerGetAtt) + API ID (markerRef)
 * - Route -> Integration ID (markerRef) + API ID (markerRef)
 * - Stage -> LogGroup ARN (markerGetAtt) + API ID (markerRef)
 * - Permission -> API ID (markerRef) + Lambda ARN (markerGetAtt)
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
  /**
   * Epic 92 wave 2.b (finding C-06): skip this pattern on intents that
   * call for a WebSocket API, a standalone resource, or "existing
   * VPC" wiring. The WebSocket case routes to `websocket-api`; the
   * standalone/only cases fall through to the LLM classifier which
   * has explicit guidance to treat them as bare resource types; the
   * "existing-vpc" case indicates the user has a VPC already and
   * doesn't want a new compound stack layered on top.
   *
   * Each negative keyword is a case-insensitive substring match.
   * "on its own" and "without api" deliberately include spaces — they
   * are full phrases rather than single tokens.
   */
  negativeKeywords: [
    "websocket",
    "standalone",
    "existing-vpc",
    "existing vpc",
    "on its own",
    "without api",
    "only the lambda",
    "just the lambda",
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
        Version: IamPolicy.VERSION,
        Statement: [
          {
            Effect: IamEffect.ALLOW,
            Principal: { Service: AwsServicePrincipal.LAMBDA },
            Action: IamPolicy.ACTION_ASSUME_ROLE,
          },
        ],
      },
      // ManagedPolicyArns grants the minimal CloudWatch Logs permissions
      // required for any Lambda to write execution logs. PermissionsBoundary
      // CAPS the maximum permission set but does NOT GRANT any permissions.
      // Commercial-partition ARN; rewriteManagedPolicyArnsForPartition() in
      // compound-plan.ts rewrites this to the correct partition at apply time.
      // (CP-4 / PH1-D-2 fix)
      ManagedPolicyArns: [
        awsManagedPolicyArn(
          "aws",
          AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
        ),
      ],
      // Commercial-partition ARN; rewriteManagedPolicyArnsForPartition() in
      // compound-plan.ts rewrites this to the correct partition at apply time.
      PermissionsBoundary: awsManagedPolicyArn(
        "aws",
        AwsManagedPolicy.POWER_USER_ACCESS_PATH,
      ),
    },
    [R.LAMBDA_FN]: {
      Runtime: AwsDefault.LAMBDA_RUNTIME,
      MemorySize: 512,
      Timeout: 30,
      Architectures: [AwsDefault.ARCH_ARM],
      // Wave 19 Bug #1 (parity fix): same Code/Handler defaults as the
      // lambda-with-exec-role pattern. Without these, this pattern would
      // hit the same `required key [Code] not found` failure as Wave 13.
      // The lambda-function.ts plugin has matching defaults for the
      // standalone path; the compound path skips plugin-defaults injection
      // and uses only the pattern's defaultOptions, so we mirror them here.
      Code: {
        ZipFile:
          "exports.handler = async (event) => ({ statusCode: 200, body: 'placeholder' });",
      },
      Handler: AwsDefault.LAMBDA_HANDLER,
      // Use a marker token instead of a CloudFormation intrinsic — CloudControl
      // does not process Fn::GetAtt. The compound plan-generator substitutes
      // this with the real IAM Role name/ARN from completedResources before
      // sending the desiredState to CloudControl.
      Role: markerGetAtt(R.IAM_EXECUTION_ROLE, "Arn"),
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
    // NOTE: Integration/Route/Stage/Permission are all `provisionable: false`
    // (see resourceList above). They're kept here as plan-only configuration
    // for display/cost/documentation; the runtime provisioner skips them.
    // They still use marker tokens (not CFN intrinsics) to keep compound
    // patterns self-consistent.
    [R.LAMBDA_INTEGRATION]: {
      ApiId: markerRef(R.HTTP_API),
      IntegrationType: "AWS_PROXY",
      IntegrationUri: markerGetAtt(R.LAMBDA_FN, "Arn"),
      PayloadFormatVersion: "2.0",
    },
    [R.DEFAULT_ROUTE]: {
      ApiId: markerRef(R.HTTP_API),
      RouteKey: "$default",
      Target: `integrations/${markerRef(R.LAMBDA_INTEGRATION)}`,
    },
    [R.DEFAULT_STAGE]: {
      ApiId: markerRef(R.HTTP_API),
      StageName: "$default",
      AutoDeploy: true,
      AccessLogSettings: {
        DestinationArn: markerGetAtt(R.ACCESS_LOG_GROUP, "Arn"),
      },
    },
    [R.API_INVOKE_PERMISSION]: {
      Action: "lambda:InvokeFunction",
      FunctionName: markerGetAtt(R.LAMBDA_FN, "Arn"),
      Principal: "apigateway.amazonaws.com",
      // SourceArn for API Gateway→Lambda permission traditionally uses
      // Fn::Sub with execute-api stub; for plan-only display we leave a
      // marker that references the HTTP API by resource ID.
      SourceArn: markerRef(R.HTTP_API),
    },
  },
};
