/**
 * WebSocket API compound pattern (Epic 92 wave 2.b — closes finding C-10).
 *
 * Bare "Create a WebSocket API" intents previously collided with the
 * `serverless-api` pattern (which emits an HTTP API Gateway v2 Api with
 * `ProtocolType: HTTP` and a single `$default` route). Users who wanted
 * realtime bidirectional messaging got an HTTP API that silently dropped
 * their `$connect` / `$disconnect` handlers and didn't work as a
 * WebSocket endpoint. This pattern fixes that by registering a dedicated
 * WebSocket compound BEFORE `serverless-api` so WebSocket intents win
 * ahead of the HTTP pattern. The `serverless-api` pattern also gained
 * the `"websocket"` negative keyword so intents like
 * "create a serverless websocket api" skip it entirely.
 *
 * Produces a complete API Gateway v2 WebSocket stack with 12 resources:
 *
 *   1. IAM Role — Lambda execution role (Lambda trust policy,
 *      PowerUserAccess permissions boundary — same safety envelope
 *      as serverless-api and lambda-with-exec-role)
 *   2. Lambda Function — the message-handler Lambda (arm64 Graviton,
 *      placeholder ZipFile handler that switches on `event.requestContext
 *      .routeKey`)
 *   3. CloudWatch LogGroup — for API Gateway access logs
 *   4. API Gateway v2 API — `ProtocolType: WEBSOCKET`,
 *      `RouteSelectionExpression: "$request.body.action"` (AWS
 *      canonical default for WebSocket APIs)
 *   5–7. Three Integrations — one each for the three canonical
 *      WebSocket routes. All three point at the SAME Lambda ARN via
 *      markerGetAtt, so the same function handles every message type.
 *      Route-specific dispatch happens inside the Lambda based on
 *      `event.requestContext.routeKey`.
 *   8–10. Three Routes — `$connect`, `$disconnect`, `$default`. The
 *      first two are AWS-reserved route keys; `$default` catches all
 *      other actions. Each route references its matching integration
 *      via markerRef.
 *   11. API Gateway v2 Stage — `production` stage with access logging
 *       to the LogGroup and AutoDeploy enabled.
 *   12. Lambda Permission — display-only (provisionable: false), grants
 *       apigateway.amazonaws.com the invoke action on the Lambda.
 *       Same treatment as serverless-api per CCAPI_REDIRECT_TYPES.
 *
 * All cross-resource references use marker tokens (parseMarker round-
 * trip) because CloudControl does NOT process CloudFormation intrinsics.
 * The plan-generator substitutes markers with physical identifiers
 * from `completedResources` at apply time.
 *
 * Integration / Route / Stage / Permission are flagged
 * `provisionable: false` for the same reason as serverless-api: the
 * CCAPI types for these sub-resources have quirks around the internal
 * null-Name NPE and Route Target format that the compound pattern
 * treats as display-only until the user runs the full `aws apigatewayv2`
 * deploy sequence post-apply. The API itself IS provisionable via
 * CCAPI so the skeleton exists in the account.
 *
 * @see https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/apis-apiid-routes.html
 */

import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "../../config/resource-types.js";
import { AwsDefault } from "../../config/cfn-keys.js";
import { markerGetAtt, markerRef } from "../../config/marker-tokens.js";
import { IamEffect } from "../../config/iam-effects.js";
import {
  AwsManagedPolicy,
  IamPolicy,
  AwsServicePrincipal,
} from "../../config/aws-arns.js";
import type { ArchitecturePattern } from "../types.js";
import { WebsocketApiResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

/** Shorthand aliases for companion resource type constants. */
const APIGATEWAYV2_INTEGRATION =
  COMPANION_RESOURCE_TYPES.APIGATEWAYV2_INTEGRATION;
const APIGATEWAYV2_ROUTE = COMPANION_RESOURCE_TYPES.APIGATEWAYV2_ROUTE;
const APIGATEWAYV2_STAGE = COMPANION_RESOURCE_TYPES.APIGATEWAYV2_STAGE;
const LAMBDA_PERMISSION = COMPANION_RESOURCE_TYPES.LAMBDA_PERMISSION;

/**
 * The AWS-reserved WebSocket route keys. Documented at
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html
 *
 * `$default` is NOT reserved in the same sense — it's the catch-all for
 * any message that doesn't match a specific action. But AWS treats all
 * three together as the canonical starter set for a WebSocket API.
 */
const WEBSOCKET_ROUTE_CONNECT = "$connect";
const WEBSOCKET_ROUTE_DISCONNECT = "$disconnect";
const WEBSOCKET_ROUTE_DEFAULT = "$default";

/**
 * WebSocket APIs use `$request.body.action` by convention — the client
 * sends `{ "action": "sendMessage", ... }` and API Gateway routes
 * based on the `action` key. This matches the AWS sample "simple-chat-
 * app" and the Serverless Framework's default WebSocket template.
 */
const WEBSOCKET_ROUTE_SELECTION_EXPRESSION = "$request.body.action";

export const websocketApiPattern: ArchitecturePattern = {
  patternId: PatternId.WEBSOCKET_API,
  displayName: "WebSocket API",
  /**
   * Keywords deliberately include the stem "websocket" plus the "ws"
   * abbreviation so any WebSocket-flavoured intent wins ahead of
   * serverless-api. Registration order in `index.ts` places this
   * pattern BEFORE serverless-api; registry iteration is first-
   * match-wins so WebSocket intents short-circuit before the HTTP
   * pattern is tested.
   */
  keywords: [
    "websocket api",
    "websocket",
    "ws api",
    "realtime api",
    "real-time api",
    "bidirectional api",
    "chat api",
    "live messaging api",
    "pub/sub api",
    "push notifications api",
  ],
  /**
   * No negative keywords — a positive "websocket" match always wins.
   * (By contrast, `serverless-api` carries `"websocket"` as a NEGATIVE
   * keyword so it falls through to this pattern.)
   */
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
      displayName: "WebSocket Message Handler Lambda",
    },
    // 3. Access LogGroup (no dependencies)
    {
      resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
      resourceId: R.ACCESS_LOG_GROUP,
      displayName: "API Gateway Access LogGroup",
    },
    // 4. API Gateway V2 Api (no dependencies)
    {
      resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
      resourceId: R.WEBSOCKET_API,
      displayName: "WebSocket API Gateway",
      provisionable: false,
    },
    // 5–7. Three Integrations — all point at the same Lambda
    {
      resourceType: APIGATEWAYV2_INTEGRATION,
      resourceId: R.CONNECT_INTEGRATION,
      displayName: "$connect → Lambda Integration",
      provisionable: false,
    },
    {
      resourceType: APIGATEWAYV2_INTEGRATION,
      resourceId: R.DISCONNECT_INTEGRATION,
      displayName: "$disconnect → Lambda Integration",
      provisionable: false,
    },
    {
      resourceType: APIGATEWAYV2_INTEGRATION,
      resourceId: R.DEFAULT_INTEGRATION,
      displayName: "$default → Lambda Integration",
      provisionable: false,
    },
    // 8–10. Three Routes — $connect, $disconnect, $default
    {
      resourceType: APIGATEWAYV2_ROUTE,
      resourceId: R.CONNECT_ROUTE,
      displayName: "$connect Route",
      provisionable: false,
    },
    {
      resourceType: APIGATEWAYV2_ROUTE,
      resourceId: R.DISCONNECT_ROUTE,
      displayName: "$disconnect Route",
      provisionable: false,
    },
    {
      resourceType: APIGATEWAYV2_ROUTE,
      resourceId: R.DEFAULT_ROUTE,
      displayName: "$default Route",
      provisionable: false,
    },
    // 11. Stage
    {
      resourceType: APIGATEWAYV2_STAGE,
      resourceId: R.DEFAULT_STAGE,
      displayName: "production Stage",
      provisionable: false,
    },
    // 12. Lambda Permission (display-only, same as serverless-api)
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
    // Group 1: Lambda + LogGroup + API — parallel (all need only Group 0 or nothing)
    [R.LAMBDA_FN, R.ACCESS_LOG_GROUP, R.WEBSOCKET_API],
    // Group 2: Integrations — need API + Lambda. All three parallel.
    [R.CONNECT_INTEGRATION, R.DISCONNECT_INTEGRATION, R.DEFAULT_INTEGRATION],
    // Group 3: Routes + Stage + Permission — Routes need their
    // Integrations + API; Stage needs API + LogGroup; Permission
    // needs API + Lambda. All parallel once Group 2 lands.
    [
      R.CONNECT_ROUTE,
      R.DISCONNECT_ROUTE,
      R.DEFAULT_ROUTE,
      R.DEFAULT_STAGE,
      R.API_INVOKE_PERMISSION,
    ],
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
      // Same safety envelope as serverless-api / lambda-with-exec-role.
      PermissionsBoundary: AwsManagedPolicy.POWER_USER_ACCESS,
    },
    [R.LAMBDA_FN]: {
      Runtime: AwsDefault.LAMBDA_RUNTIME,
      MemorySize: 512,
      Timeout: 30,
      Architectures: [AwsDefault.ARCH_ARM],
      // Placeholder handler — dispatches on event.requestContext.routeKey
      // so the user can replace each branch (connect, disconnect,
      // default-action) with real logic post-apply without re-architecting.
      Code: {
        ZipFile:
          "exports.handler = async (event) => { const routeKey = event.requestContext && event.requestContext.routeKey; console.log('websocket invocation', routeKey); return { statusCode: 200, body: 'ok' }; };",
      },
      Handler: AwsDefault.LAMBDA_HANDLER,
      // Marker token — compound plan-generator resolves to real role
      // ARN at apply time via the same path used by serverless-api
      // and lambda-with-exec-role.
      Role: markerGetAtt(R.IAM_EXECUTION_ROLE, "Arn"),
    },
    [R.ACCESS_LOG_GROUP]: {
      LogGroupName: "/aws/apigateway/websocket-api",
      RetentionInDays: 14,
    },
    [R.WEBSOCKET_API]: {
      ProtocolType: AwsDefault.PROTOCOL_WEBSOCKET,
      // Canonical WebSocket routing expression — "action" key in
      // request body determines which route is selected.
      RouteSelectionExpression: WEBSOCKET_ROUTE_SELECTION_EXPRESSION,
    },
    // Integrations — all three point at the SAME Lambda. The Lambda's
    // handler is responsible for dispatching based on routeKey.
    [R.CONNECT_INTEGRATION]: {
      ApiId: markerRef(R.WEBSOCKET_API),
      IntegrationType: "AWS_PROXY",
      IntegrationUri: markerGetAtt(R.LAMBDA_FN, "Arn"),
    },
    [R.DISCONNECT_INTEGRATION]: {
      ApiId: markerRef(R.WEBSOCKET_API),
      IntegrationType: "AWS_PROXY",
      IntegrationUri: markerGetAtt(R.LAMBDA_FN, "Arn"),
    },
    [R.DEFAULT_INTEGRATION]: {
      ApiId: markerRef(R.WEBSOCKET_API),
      IntegrationType: "AWS_PROXY",
      IntegrationUri: markerGetAtt(R.LAMBDA_FN, "Arn"),
    },
    // Routes — each references its matching Integration. WebSocket
    // Route Target format is `integrations/<integration-id>` (same as
    // HTTP API v2).
    [R.CONNECT_ROUTE]: {
      ApiId: markerRef(R.WEBSOCKET_API),
      RouteKey: WEBSOCKET_ROUTE_CONNECT,
      Target: `integrations/${markerRef(R.CONNECT_INTEGRATION)}`,
    },
    [R.DISCONNECT_ROUTE]: {
      ApiId: markerRef(R.WEBSOCKET_API),
      RouteKey: WEBSOCKET_ROUTE_DISCONNECT,
      Target: `integrations/${markerRef(R.DISCONNECT_INTEGRATION)}`,
    },
    [R.DEFAULT_ROUTE]: {
      ApiId: markerRef(R.WEBSOCKET_API),
      RouteKey: WEBSOCKET_ROUTE_DEFAULT,
      Target: `integrations/${markerRef(R.DEFAULT_INTEGRATION)}`,
    },
    [R.DEFAULT_STAGE]: {
      ApiId: markerRef(R.WEBSOCKET_API),
      // "production" instead of "$default" — WebSocket Stages are
      // typically named environments rather than the $default stage
      // used for HTTP APIs. Matches AWS sample templates.
      StageName: "production",
      AutoDeploy: true,
      AccessLogSettings: {
        DestinationArn: markerGetAtt(R.ACCESS_LOG_GROUP, "Arn"),
      },
    },
    [R.API_INVOKE_PERMISSION]: {
      Action: "lambda:InvokeFunction",
      FunctionName: markerGetAtt(R.LAMBDA_FN, "Arn"),
      Principal: "apigateway.amazonaws.com",
      // Same marker convention as serverless-api for SourceArn —
      // plan-only display; users run `aws lambda add-permission`
      // post-apply with the real SourceArn that includes the
      // execute-api ARN path.
      SourceArn: markerRef(R.WEBSOCKET_API),
    },
  },
};

/**
 * Pattern-level helper for finding D-26 (SNS::Subscription Protocol
 * inference).
 *
 * The parser half (e92.2.a) extracts a user-provided `Endpoint` into
 * `elicitedOptions`. If a compound pattern ever adds AWS::SNS::Subscription
 * to its resourceList, the pattern can call this helper from its
 * `defaultOptions` factory (future extension — current pattern templates
 * use plain object literals) to infer `Protocol` from the Endpoint scheme
 * without hardcoding `Protocol: "http"` into defaults.
 *
 * Rules (per
 * https://docs.aws.amazon.com/sns/latest/api/API_Subscribe.html):
 *   - `http://...`   → "http"
 *   - `https://...`  → "https"
 *   - `arn:aws*:sqs:...` → "sqs"
 *   - `arn:aws*:lambda:...` → "lambda"
 *   - `arn:aws*:sns:...` (cross-region topic) → "sns"
 *   - bare e-mail (`foo@bar.com`) → "email"
 *   - phone (`+15551234567`) → "sms"
 *   - anything else → `undefined` (bail on ambiguity — caller should
 *     present an elicitation prompt rather than guess).
 *
 * This helper deliberately uses `/^arn:aws[\w-]*:/` to cover GovCloud
 * and China partitions (per feedback_partition_aware_arn_matching).
 *
 * @param endpoint User-provided Endpoint string. `undefined` when the
 *                 intent never mentioned one → helper returns undefined
 *                 (caller bails).
 * @returns Inferred SNS Subscription Protocol, or `undefined` when the
 *          endpoint is missing / ambiguous / malformed.
 */
export function inferSnsSubscriptionProtocol(
  endpoint: string | undefined,
): string | undefined {
  if (typeof endpoint !== "string" || endpoint.length === 0) return undefined;
  const trimmed = endpoint.trim();
  if (trimmed.startsWith("https://")) return "https";
  if (trimmed.startsWith("http://")) return "http";
  // Partition-aware ARN match — covers aws, aws-cn, aws-us-gov, aws-iso*.
  const arnMatch = /^arn:aws[\w-]*:([a-z0-9-]+):/i.exec(trimmed);
  if (arnMatch) {
    const service = arnMatch[1]?.toLowerCase();
    if (service === "sqs") return "sqs";
    if (service === "lambda") return "lambda";
    if (service === "sns") return "sns";
    // Other ARN services (e.g. firehose, events) are NOT valid SNS
    // subscription Protocols — bail on ambiguity.
    return undefined;
  }
  // Bare e-mail — simple regex that insists on an @ and a dot in the
  // right order. Deliberately conservative; a malformed address should
  // bail rather than silently subscribe.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "email";
  // E.164-style phone number — leading +, 8–15 digits.
  if (/^\+\d{8,15}$/.test(trimmed)) return "sms";
  return undefined;
}
