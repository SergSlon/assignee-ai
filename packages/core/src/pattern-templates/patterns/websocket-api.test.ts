/**
 * Epic 92 wave 2.b — tests for the websocket-api pattern.
 *
 * Pins:
 *   - Pattern structure: 12 resources, marker-token wiring, correct
 *     ProtocolType / RouteSelectionExpression on the API
 *   - Keyword detection: matches WebSocket-flavoured intents and wins
 *     ahead of serverless-api in the default registration order
 *   - Negative trigger: HTTP-only intents do NOT match this pattern
 *   - SNS Protocol inference helper: covers every canonical endpoint
 *     shape AND bails on ambiguity (D-26 pattern half)
 */

import { describe, it, expect } from "vitest";
import {
  websocketApiPattern,
  inferSnsSubscriptionProtocol,
} from "./websocket-api.js";
import { serverlessApiPattern } from "./serverless-api.js";
import { PatternRegistry } from "../registry.js";
import { PatternId } from "../pattern-ids.js";
import { WebsocketApiResourceId as R } from "../pattern-resource-ids.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { parseMarker } from "../../config/marker-tokens.js";
import {
  AwsServicePrincipal,
  AwsManagedPolicy,
  awsManagedPolicyArn,
} from "../../config/aws-arns.js";
import { rewriteManagedPolicyArnsForPartition } from "../../graph/nodes/plan-generator/compound-helpers.js";

/**
 * Build a registry in the canonical registration order defined in
 * `pattern-templates/index.ts` — websocket-api BEFORE serverless-api so
 * WebSocket intents win ahead of the HTTP pattern.
 */
function buildRegistry(): PatternRegistry {
  const r = new PatternRegistry();
  r.register(websocketApiPattern);
  r.register(serverlessApiPattern);
  return r;
}

describe("websocketApiPattern — structure", () => {
  const pattern = websocketApiPattern;

  it("has patternId 'websocket-api'", () => {
    expect(pattern.patternId).toBe(PatternId.WEBSOCKET_API);
  });

  it("has a human-readable displayName that mentions WebSocket", () => {
    expect(pattern.displayName).toMatch(/WebSocket/);
  });

  it("has at least 5 keywords for detection", () => {
    expect(pattern.keywords.length).toBeGreaterThanOrEqual(5);
  });

  it("every keyword is a non-empty lowercase string", () => {
    for (const kw of pattern.keywords) {
      expect(typeof kw).toBe("string");
      expect(kw.length).toBeGreaterThan(0);
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("contains exactly 12 resources", () => {
    expect(pattern.resourceList).toHaveLength(12);
  });

  it("every resource has required fields", () => {
    for (const res of pattern.resourceList) {
      expect(res.resourceType).toBeTruthy();
      expect(res.resourceId).toBeTruthy();
      expect(res.displayName).toBeTruthy();
    }
  });

  it("resource types match the WebSocket compound surface", () => {
    const types = pattern.resourceList.map((r) => r.resourceType);
    expect(types).toEqual([
      RESOURCE_TYPES.IAM_ROLE,
      RESOURCE_TYPES.LAMBDA_FUNCTION,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      RESOURCE_TYPES.APIGATEWAYV2_API,
      "AWS::ApiGatewayV2::Integration",
      "AWS::ApiGatewayV2::Integration",
      "AWS::ApiGatewayV2::Integration",
      "AWS::ApiGatewayV2::Route",
      "AWS::ApiGatewayV2::Route",
      "AWS::ApiGatewayV2::Route",
      "AWS::ApiGatewayV2::Stage",
      "AWS::Lambda::Permission",
    ]);
  });

  it("dependencyOrder and resourceList cover identical resourceId sets", () => {
    const depIds = new Set(pattern.dependencyOrder.flat());
    const listIds = new Set(pattern.resourceList.map((r) => r.resourceId));
    expect(depIds).toEqual(listIds);
  });

  it("every dependencyOrder id has a defaultOptions entry", () => {
    for (const id of pattern.dependencyOrder.flat()) {
      expect(pattern.defaultOptions[id]).toBeTypeOf("object");
    }
  });

  it("IAM Role + Lambda + LogGroup are provisionable; API + subs are not", () => {
    const provByResourceId = Object.fromEntries(
      pattern.resourceList.map((r) => [r.resourceId, r.provisionable]),
    );
    expect(provByResourceId[R.IAM_EXECUTION_ROLE]).not.toBe(false);
    expect(provByResourceId[R.LAMBDA_FN]).not.toBe(false);
    expect(provByResourceId[R.ACCESS_LOG_GROUP]).not.toBe(false);
    // API + Integration + Route + Stage + Permission are display-only
    expect(provByResourceId[R.WEBSOCKET_API]).toBe(false);
    expect(provByResourceId[R.CONNECT_INTEGRATION]).toBe(false);
    expect(provByResourceId[R.DISCONNECT_INTEGRATION]).toBe(false);
    expect(provByResourceId[R.DEFAULT_INTEGRATION]).toBe(false);
    expect(provByResourceId[R.CONNECT_ROUTE]).toBe(false);
    expect(provByResourceId[R.DISCONNECT_ROUTE]).toBe(false);
    expect(provByResourceId[R.DEFAULT_ROUTE]).toBe(false);
    expect(provByResourceId[R.DEFAULT_STAGE]).toBe(false);
    expect(provByResourceId[R.API_INVOKE_PERMISSION]).toBe(false);
  });
});

describe("websocketApiPattern — marker token wiring", () => {
  const opts = websocketApiPattern.defaultOptions;

  it("IAM Role uses Lambda trust policy + PowerUserAccess boundary (commercial partition)", () => {
    const role = opts[R.IAM_EXECUTION_ROLE] as Record<string, unknown>;
    const trust = role["AssumeRolePolicyDocument"] as {
      Statement: Array<{ Principal: { Service: string } }>;
    };
    expect(trust.Statement[0]!.Principal.Service).toBe(
      AwsServicePrincipal.LAMBDA,
    );
    expect(role["PermissionsBoundary"]).toBe(
      awsManagedPolicyArn("aws", AwsManagedPolicy.POWER_USER_ACCESS_PATH),
    );
  });

  it("IAM Role attaches AWSLambdaBasicExecutionRole (CP-4 / PH1-D-2 fix)", () => {
    const role = opts[R.IAM_EXECUTION_ROLE] as Record<string, unknown>;
    const managedPolicies = role["ManagedPolicyArns"] as string[];
    expect(Array.isArray(managedPolicies)).toBe(true);
    expect(managedPolicies.length).toBeGreaterThan(0);
    const expectedArn = awsManagedPolicyArn(
      "aws",
      AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
    );
    expect(managedPolicies).toContain(expectedArn);
    expect(expectedArn).toMatch(/service-role\/AWSLambdaBasicExecutionRole$/);
  });

  it("rewriteManagedPolicyArnsForPartition rewrites PermissionsBoundary to GovCloud partition (W-010)", () => {
    // Clone the static defaultOptions slot so we don't mutate the shared pattern object.
    const roleSlot = {
      ...(opts[R.IAM_EXECUTION_ROLE] as Record<string, unknown>),
    };
    // Deep-clone ManagedPolicyArns array to avoid mutating the shared pattern
    if (Array.isArray(roleSlot["ManagedPolicyArns"])) {
      roleSlot["ManagedPolicyArns"] = [
        ...(roleSlot["ManagedPolicyArns"] as string[]),
      ];
    }
    rewriteManagedPolicyArnsForPartition(roleSlot, "aws-us-gov");
    expect(roleSlot["PermissionsBoundary"]).toBe(
      awsManagedPolicyArn(
        "aws-us-gov",
        AwsManagedPolicy.POWER_USER_ACCESS_PATH,
      ),
    );
    expect(roleSlot["PermissionsBoundary"]).toMatch(
      /^arn:aws-us-gov:iam::aws:policy\//,
    );
  });

  it("rewriteManagedPolicyArnsForPartition rewrites ManagedPolicyArns to GovCloud partition (Variation E — CP-4)", () => {
    const roleSlot = {
      ...(opts[R.IAM_EXECUTION_ROLE] as Record<string, unknown>),
    };
    roleSlot["ManagedPolicyArns"] = [
      ...(roleSlot["ManagedPolicyArns"] as string[]),
    ];
    rewriteManagedPolicyArnsForPartition(roleSlot, "aws-us-gov");
    const rewritten = roleSlot["ManagedPolicyArns"] as string[];
    expect(rewritten[0]).toBe(
      awsManagedPolicyArn(
        "aws-us-gov",
        AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
      ),
    );
    expect(rewritten[0]).toMatch(/^arn:aws-us-gov:iam::aws:policy\//);
    expect(rewritten[0]).toMatch(/service-role\/AWSLambdaBasicExecutionRole$/);
  });

  it("rewriteManagedPolicyArnsForPartition is a no-op for commercial partition (W-010)", () => {
    const roleSlot = {
      ...(opts[R.IAM_EXECUTION_ROLE] as Record<string, unknown>),
    };
    const originalBoundary = roleSlot["PermissionsBoundary"];
    rewriteManagedPolicyArnsForPartition(roleSlot, "aws");
    expect(roleSlot["PermissionsBoundary"]).toBe(originalBoundary);
  });

  it("Lambda Role field is a marker token pointing at the IAM Role's Arn", () => {
    const lambda = opts[R.LAMBDA_FN] as Record<string, unknown>;
    expect(String(lambda["Role"])).toBe(
      "__ASSIGNEE_GETATT_iam-execution-role_Arn__",
    );
  });

  it("Lambda handler Code mentions the WebSocket routeKey dispatch idiom", () => {
    const code = (opts[R.LAMBDA_FN] as { Code?: { ZipFile?: string } })?.Code;
    expect(code?.ZipFile).toMatch(/routeKey/);
  });

  it("API has ProtocolType WEBSOCKET and the canonical RouteSelectionExpression", () => {
    const api = opts[R.WEBSOCKET_API] as Record<string, unknown>;
    expect(api["ProtocolType"]).toBe("WEBSOCKET");
    expect(api["RouteSelectionExpression"]).toBe("$request.body.action");
  });

  it("all three integrations point at the SAME Lambda via markerGetAtt", () => {
    for (const id of [
      R.CONNECT_INTEGRATION,
      R.DISCONNECT_INTEGRATION,
      R.DEFAULT_INTEGRATION,
    ]) {
      const integration = opts[id] as Record<string, unknown>;
      expect(integration["IntegrationType"]).toBe("AWS_PROXY");
      expect(integration["IntegrationUri"]).toBe(
        "__ASSIGNEE_GETATT_lambda-fn_Arn__",
      );
      expect(integration["ApiId"]).toBe("__ASSIGNEE_REF_websocket-api__");
    }
  });

  it("each route targets its matching integration via markerRef-wrapped Target", () => {
    const cases = [
      {
        route: R.CONNECT_ROUTE,
        integration: R.CONNECT_INTEGRATION,
        key: "$connect",
      },
      {
        route: R.DISCONNECT_ROUTE,
        integration: R.DISCONNECT_INTEGRATION,
        key: "$disconnect",
      },
      {
        route: R.DEFAULT_ROUTE,
        integration: R.DEFAULT_INTEGRATION,
        key: "$default",
      },
    ];
    for (const { route, integration, key } of cases) {
      const opts_ = opts[route] as Record<string, unknown>;
      expect(opts_["RouteKey"]).toBe(key);
      expect(opts_["ApiId"]).toBe("__ASSIGNEE_REF_websocket-api__");
      expect(opts_["Target"]).toBe(
        `integrations/__ASSIGNEE_REF_${integration}__`,
      );
    }
  });

  it("Stage uses `production` name, AutoDeploy true, and access-log LogGroup", () => {
    const stage = opts[R.DEFAULT_STAGE] as Record<string, unknown>;
    expect(stage["StageName"]).toBe("production");
    expect(stage["AutoDeploy"]).toBe(true);
    const accessLog = stage["AccessLogSettings"] as Record<string, unknown>;
    expect(accessLog["DestinationArn"]).toBe(
      "__ASSIGNEE_GETATT_access-log-group_Arn__",
    );
  });

  it("Permission grants API Gateway invoke-function with markers for Fn + Source", () => {
    const perm = opts[R.API_INVOKE_PERMISSION] as Record<string, unknown>;
    expect(perm["Action"]).toBe("lambda:InvokeFunction");
    expect(perm["Principal"]).toBe("apigateway.amazonaws.com");
    expect(perm["FunctionName"]).toBe("__ASSIGNEE_GETATT_lambda-fn_Arn__");
    expect(perm["SourceArn"]).toBe("__ASSIGNEE_REF_websocket-api__");
  });

  it("emits zero CloudFormation intrinsics (Fn::*, Ref objects)", () => {
    const serialized = JSON.stringify(websocketApiPattern.defaultOptions);
    expect(serialized).not.toMatch(/"Fn::/);
    expect(serialized).not.toMatch(/"Ref":/);
  });

  it("every marker string parses back as a well-formed marker token", () => {
    const walk = (value: unknown): void => {
      if (typeof value === "string" && value.startsWith("__ASSIGNEE_")) {
        const parsed = parseMarker(value);
        expect(parsed).not.toBeNull();
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === "object") {
        Object.values(value as Record<string, unknown>).forEach(walk);
      }
    };
    walk(websocketApiPattern.defaultOptions);
  });
});

describe("websocketApiPattern — dependency ordering", () => {
  const pattern = websocketApiPattern;
  const groupIndex = new Map<string, number>();
  pattern.dependencyOrder.forEach((group, i) =>
    group.forEach((id) => groupIndex.set(id, i)),
  );

  it("IAM role is in the first group", () => {
    expect(groupIndex.get(R.IAM_EXECUTION_ROLE)).toBe(0);
  });

  it("Lambda + LogGroup + API share the second group (parallelizable)", () => {
    const lambdaGroup = groupIndex.get(R.LAMBDA_FN)!;
    expect(groupIndex.get(R.ACCESS_LOG_GROUP)).toBe(lambdaGroup);
    expect(groupIndex.get(R.WEBSOCKET_API)).toBe(lambdaGroup);
    expect(lambdaGroup).toBeGreaterThan(groupIndex.get(R.IAM_EXECUTION_ROLE)!);
  });

  it("Integrations run after the API + Lambda", () => {
    const connectGroup = groupIndex.get(R.CONNECT_INTEGRATION)!;
    expect(connectGroup).toBeGreaterThan(groupIndex.get(R.WEBSOCKET_API)!);
    expect(connectGroup).toBeGreaterThan(groupIndex.get(R.LAMBDA_FN)!);
    // All three integrations are in the same group (parallel)
    expect(groupIndex.get(R.DISCONNECT_INTEGRATION)).toBe(connectGroup);
    expect(groupIndex.get(R.DEFAULT_INTEGRATION)).toBe(connectGroup);
  });

  it("Routes + Stage + Permission all land in the final group", () => {
    const routeGroup = groupIndex.get(R.CONNECT_ROUTE)!;
    const integrationGroup = groupIndex.get(R.CONNECT_INTEGRATION)!;
    expect(routeGroup).toBeGreaterThan(integrationGroup);
    for (const id of [
      R.DISCONNECT_ROUTE,
      R.DEFAULT_ROUTE,
      R.DEFAULT_STAGE,
      R.API_INVOKE_PERMISSION,
    ]) {
      expect(groupIndex.get(id)).toBe(routeGroup);
    }
  });
});

describe("websocketApiPattern — registry detection & ordering", () => {
  const positiveCases = [
    "create a websocket api",
    "build a websocket",
    "deploy a ws api",
    "I need a realtime api for chat",
    "set up a real-time api",
    "bidirectional api for game server",
    "chat api with persistent connections",
    "live messaging api for my mobile app",
    "pub/sub api",
    "push notifications api for mobile clients",
  ];

  for (const intent of positiveCases) {
    it(`detects "${intent}" as websocket-api (wins ahead of serverless-api)`, () => {
      const registry = buildRegistry();
      const detected = registry.detect(intent);
      expect(detected?.patternId).toBe(PatternId.WEBSOCKET_API);
    });
  }

  it("plain 'create a serverless api' still routes to serverless-api", () => {
    const registry = buildRegistry();
    expect(registry.detect("create a serverless api")).toBe(
      serverlessApiPattern,
    );
  });

  it("plain 'create an api' still routes to serverless-api (HTTP)", () => {
    const registry = buildRegistry();
    // "create an api" matches serverless-api positive keyword and does
    // NOT mention websocket, so serverless-api wins.
    expect(registry.detect("create an api")).toBe(serverlessApiPattern);
  });

  it("'create a serverless websocket api' routes to websocket-api", () => {
    // websocket keyword fires first. Serverless-api ALSO has "websocket"
    // in its negativeKeywords → the HTTP pattern cannot claim this
    // intent even if registered first. Here we additionally verify the
    // websocket pattern catches it in the canonical registration order.
    const registry = buildRegistry();
    const detected = registry.detect("create a serverless websocket api");
    expect(detected?.patternId).toBe(PatternId.WEBSOCKET_API);
  });

  it("an intent with no websocket cue returns serverless-api or null", () => {
    const registry = buildRegistry();
    // Nothing matches
    expect(registry.detect("create an s3 bucket")).toBeNull();
  });

  it("is registered in the default registry under the correct patternId", async () => {
    const { defaultPatternRegistry } = await import("../index.js");
    expect(defaultPatternRegistry.has(PatternId.WEBSOCKET_API)).toBe(true);
    expect(defaultPatternRegistry.get(PatternId.WEBSOCKET_API)).toBe(
      websocketApiPattern,
    );
  });

  it("default registry wins websocket-api ahead of serverless-api for WS intents", async () => {
    const { defaultPatternRegistry } = await import("../index.js");
    expect(
      defaultPatternRegistry.detect("build a websocket api for notifications")
        ?.patternId,
    ).toBe(PatternId.WEBSOCKET_API);
  });
});

describe("inferSnsSubscriptionProtocol — D-26 pattern half", () => {
  it("returns 'http' for http:// endpoints", () => {
    expect(inferSnsSubscriptionProtocol("http://example.com/webhook")).toBe(
      "http",
    );
  });

  it("returns 'https' for https:// endpoints", () => {
    expect(inferSnsSubscriptionProtocol("https://example.com/webhook")).toBe(
      "https",
    );
  });

  it("returns 'sqs' for SQS ARN endpoints", () => {
    expect(
      inferSnsSubscriptionProtocol(
        "arn:aws:sqs:us-east-1:210987654321:my-queue",
      ),
    ).toBe("sqs");
  });

  it("returns 'lambda' for Lambda ARN endpoints", () => {
    expect(
      inferSnsSubscriptionProtocol(
        "arn:aws:lambda:us-east-1:210987654321:function:notify",
      ),
    ).toBe("lambda");
  });

  it("returns 'sns' for cross-region SNS topic endpoints", () => {
    expect(
      inferSnsSubscriptionProtocol(
        "arn:aws:sns:eu-west-1:210987654321:other-topic",
      ),
    ).toBe("sns");
  });

  it("returns 'email' for well-formed e-mail endpoints", () => {
    expect(inferSnsSubscriptionProtocol("alerts@example.com")).toBe("email");
  });

  it("returns 'sms' for E.164 phone-number endpoints", () => {
    expect(inferSnsSubscriptionProtocol("+15551234567")).toBe("sms");
  });

  it("handles GovCloud partition ARNs (aws-us-gov)", () => {
    expect(
      inferSnsSubscriptionProtocol(
        "arn:aws-us-gov:sqs:us-gov-west-1:210987654321:gov-queue",
      ),
    ).toBe("sqs");
  });

  it("handles China partition ARNs (aws-cn)", () => {
    expect(
      inferSnsSubscriptionProtocol(
        "arn:aws-cn:lambda:cn-north-1:210987654321:function:cn-notify",
      ),
    ).toBe("lambda");
  });

  it("returns undefined on ambiguous ARN (unsupported service)", () => {
    expect(
      inferSnsSubscriptionProtocol(
        "arn:aws:firehose:us-east-1:210987654321:deliverystream/my-stream",
      ),
    ).toBeUndefined();
  });

  it("returns undefined on malformed e-mail (no domain)", () => {
    expect(inferSnsSubscriptionProtocol("not-an-email")).toBeUndefined();
  });

  it("returns undefined on empty string", () => {
    expect(inferSnsSubscriptionProtocol("")).toBeUndefined();
  });

  it("returns undefined on undefined input (bail on missing)", () => {
    expect(inferSnsSubscriptionProtocol(undefined)).toBeUndefined();
  });

  it("returns undefined on phone number with too few digits", () => {
    expect(inferSnsSubscriptionProtocol("+12")).toBeUndefined();
  });

  it("trims leading/trailing whitespace before matching", () => {
    expect(
      inferSnsSubscriptionProtocol("  https://example.com/webhook  "),
    ).toBe("https");
  });
});
