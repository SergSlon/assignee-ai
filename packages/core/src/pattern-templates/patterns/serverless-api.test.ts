import { describe, it, expect } from "vitest";
import { serverlessApiPattern } from "./serverless-api.js";
import { threeTierWebPattern } from "./three-tier-web.js";
import { containerServicePattern } from "./container-service.js";
import { messageProcessingPattern } from "./message-processing.js";
import { staticWebsitePattern } from "./static-website.js";
import { PatternRegistry } from "../registry.js";
import {
  AwsManagedPolicy,
  awsManagedPolicyArn,
} from "../../config/aws-arns.js";

/** Build a fresh registry with all 5 patterns registered in canonical order. */
function buildRegistry(): PatternRegistry {
  const r = new PatternRegistry();
  [
    serverlessApiPattern,
    threeTierWebPattern,
    containerServicePattern,
    messageProcessingPattern,
    staticWebsitePattern,
  ].forEach((p) => r.register(p));
  return r;
}

describe("Pattern keyword detection", () => {
  const registry = buildRegistry();

  it("detects serverless-api from multiple variants", () => {
    expect(registry.detect("create a serverless api")).toBe(
      serverlessApiPattern,
    );
    expect(registry.detect("build a rest api with lambda")).toBe(
      serverlessApiPattern,
    );
    expect(registry.detect("set up api gateway")).toBe(serverlessApiPattern);
  });

  it("detects serverless-api from new trigger phrases (Story 26.4)", () => {
    expect(registry.detect("create an api")).toBe(serverlessApiPattern);
    expect(registry.detect("build an http api")).toBe(serverlessApiPattern);
    expect(registry.detect("serverless rest api")).toBe(serverlessApiPattern);
  });

  it("detects three-tier-web from multiple variants", () => {
    expect(registry.detect("build a three tier app")).toBe(threeTierWebPattern);
    expect(registry.detect("create a 3 tier web app")).toBe(
      threeTierWebPattern,
    );
    expect(registry.detect("web application with database backend")).toBe(
      threeTierWebPattern,
    );
  });

  it("detects container-service from multiple variants", () => {
    expect(registry.detect("deploy a container service")).toBe(
      containerServicePattern,
    );
    expect(registry.detect("set up ecs fargate cluster")).toBe(
      containerServicePattern,
    );
    expect(registry.detect("run a containerized app on AWS")).toBe(
      containerServicePattern,
    );
  });

  it("detects message-processing from multiple variants", () => {
    expect(registry.detect("create sqs lambda processor")).toBe(
      messageProcessingPattern,
    );
    expect(registry.detect("set up message processing pipeline")).toBe(
      messageProcessingPattern,
    );
    expect(registry.detect("async processing pipeline for orders")).toBe(
      messageProcessingPattern,
    );
  });

  it("detects static-website from multiple variants", () => {
    expect(registry.detect("host a static website")).toBe(staticWebsitePattern);
    expect(registry.detect("deploy a static site")).toBe(staticWebsitePattern);
    expect(registry.detect("spa hosting on AWS")).toBe(staticWebsitePattern);
  });

  it("returns null for non-pattern intent", () => {
    expect(registry.detect("create an S3 bucket")).toBeNull();
    expect(registry.detect("add an IAM role")).toBeNull();
    expect(registry.detect("provision an EC2 instance")).toBeNull();
  });

  describe("serverless-api — negative keyword triggers (Epic 92 wave 2.b)", () => {
    // Registry-only test — no websocket-api registered so "websocket"
    // in the intent disqualifies serverless-api and returns null.
    // When websocket-api IS registered (the default registry), WebSocket
    // intents route there. See websocket-api.test.ts for that coverage.
    it("skips serverless-api on 'create a serverless websocket api'", () => {
      expect(registry.detect("create a serverless websocket api")).toBeNull();
    });

    it("skips serverless-api on 'create an api (standalone)'", () => {
      expect(
        registry.detect("create an api (standalone) for my Lambda"),
      ).toBeNull();
    });

    it("skips serverless-api on 'build an http api on its own'", () => {
      expect(registry.detect("build an http api on its own")).toBeNull();
    });

    it("skips serverless-api when user says 'existing vpc'", () => {
      expect(
        registry.detect("create an api that attaches to my existing vpc"),
      ).toBeNull();
    });

    it("skips serverless-api on 'just the lambda, no api'", () => {
      expect(
        registry.detect(
          "create a lambda function with api — just the lambda please",
        ),
      ).toBeNull();
    });

    it("skips serverless-api on 'only the lambda' phrasing", () => {
      expect(registry.detect("create an api but only the lambda")).toBeNull();
    });

    it("still matches serverless-api on plain positive intents (baseline)", () => {
      expect(registry.detect("create a serverless api")).toBe(
        serverlessApiPattern,
      );
      expect(registry.detect("build an http api")).toBe(serverlessApiPattern);
    });
  });
});

describe("Pattern dependencyOrder integrity", () => {
  const allPatterns = [
    serverlessApiPattern,
    threeTierWebPattern,
    containerServicePattern,
    messageProcessingPattern,
    staticWebsitePattern,
  ];

  it.each(allPatterns)(
    "$patternId: all dependencyOrder resourceIds exist in resourceList",
    (pattern) => {
      const validIds = new Set(pattern.resourceList.map((r) => r.resourceId));
      const allDepIds = pattern.dependencyOrder.flat();
      for (const id of allDepIds) {
        expect(
          validIds.has(id),
          `resourceId "${id}" in dependencyOrder not found in resourceList`,
        ).toBe(true);
      }
    },
  );

  it.each(allPatterns)("$patternId: has at least 5 keywords", (pattern) => {
    expect(pattern.keywords.length).toBeGreaterThanOrEqual(5);
  });

  it.each(allPatterns)(
    "$patternId: has at least 1 resource in resourceList",
    (pattern) => {
      expect(pattern.resourceList.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(allPatterns)(
    "$patternId: every resourceId in resourceList appears in dependencyOrder",
    (pattern) => {
      const depIds = new Set(pattern.dependencyOrder.flat());
      for (const r of pattern.resourceList) {
        expect(
          depIds.has(r.resourceId),
          `resourceId "${r.resourceId}" in resourceList not found in dependencyOrder`,
        ).toBe(true);
      }
    },
  );
});

describe("Serverless API pattern (Story 26.4)", () => {
  it("has correct patternId", () => {
    expect(serverlessApiPattern.patternId).toBe("serverless-api");
  });

  it("produces exactly 8 resources", () => {
    expect(serverlessApiPattern.resourceList).toHaveLength(8);
  });

  it("resources are in correct dependency order", () => {
    const resourceIds = serverlessApiPattern.resourceList.map(
      (r) => r.resourceId,
    );
    expect(resourceIds).toEqual([
      "iam-execution-role",
      "lambda-fn",
      "access-log-group",
      "http-api",
      "lambda-integration",
      "default-route",
      "default-stage",
      "api-invoke-permission",
    ]);
  });

  it("has correct resource types for all 8 resources", () => {
    const types = serverlessApiPattern.resourceList.map((r) => r.resourceType);
    expect(types).toEqual([
      "AWS::IAM::Role",
      "AWS::Lambda::Function",
      "AWS::Logs::LogGroup",
      "AWS::ApiGatewayV2::Api",
      "AWS::ApiGatewayV2::Integration",
      "AWS::ApiGatewayV2::Route",
      "AWS::ApiGatewayV2::Stage",
      "AWS::Lambda::Permission",
    ]);
  });

  it("Lambda references IAM Role ARN via marker token", () => {
    const lambdaOpts = serverlessApiPattern.defaultOptions["lambda-fn"];
    expect(lambdaOpts?.["Role"]).toBe(
      "__ASSIGNEE_GETATT_iam-execution-role_Arn__",
    );
  });

  it("Integration references Lambda ARN and API ID via marker tokens", () => {
    const integrationOpts =
      serverlessApiPattern.defaultOptions["lambda-integration"];
    expect(integrationOpts?.["IntegrationUri"]).toBe(
      "__ASSIGNEE_GETATT_lambda-fn_Arn__",
    );
    expect(integrationOpts?.["ApiId"]).toBe("__ASSIGNEE_REF_http-api__");
  });

  it("Route references API ID and Integration ID", () => {
    // Tier C: strengthened — Target should reference the integration via
    // marker token, not just "be defined"
    const routeOpts = serverlessApiPattern.defaultOptions["default-route"];
    expect(routeOpts?.["ApiId"]).toBe("__ASSIGNEE_REF_http-api__");
    expect(routeOpts?.["Target"]).toMatch(/^integrations\/__ASSIGNEE_REF_/);
  });

  it("Stage references LogGroup ARN and API ID via marker tokens", () => {
    const stageOpts = serverlessApiPattern.defaultOptions["default-stage"];
    expect(stageOpts?.["ApiId"]).toBe("__ASSIGNEE_REF_http-api__");
    const accessLog = stageOpts?.["AccessLogSettings"] as Record<
      string,
      unknown
    >;
    expect(accessLog?.["DestinationArn"]).toBe(
      "__ASSIGNEE_GETATT_access-log-group_Arn__",
    );
  });

  it("Permission references Lambda ARN and API Gateway source", () => {
    // Tier C: strengthened — SourceArn should reference the HTTP API
    // marker, not just "be defined"
    const permOpts =
      serverlessApiPattern.defaultOptions["api-invoke-permission"];
    expect(permOpts?.["FunctionName"]).toBe(
      "__ASSIGNEE_GETATT_lambda-fn_Arn__",
    );
    expect(permOpts?.["Principal"]).toBe("apigateway.amazonaws.com");
    expect(permOpts?.["SourceArn"]).toBe("__ASSIGNEE_REF_http-api__");
  });

  it("emits no CloudFormation intrinsics in defaultOptions", () => {
    // CloudControl API does not process Fn::* or { Ref } — compound patterns
    // must use marker tokens that the plan-generator resolves at runtime.
    const serialized = JSON.stringify(serverlessApiPattern.defaultOptions);
    expect(serialized).not.toMatch(/"Fn::/);
    expect(serialized).not.toMatch(/"Ref":/);
  });

  it("IAM Role attaches AWSLambdaBasicExecutionRole (CP-4 / PH1-D-2 fix)", () => {
    const roleOpts = serverlessApiPattern.defaultOptions["iam-execution-role"];
    const managedPolicies = roleOpts?.["ManagedPolicyArns"] as string[];
    expect(Array.isArray(managedPolicies)).toBe(true);
    expect(managedPolicies.length).toBeGreaterThan(0);
    const expectedArn = awsManagedPolicyArn(
      "aws",
      AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
    );
    expect(managedPolicies).toContain(expectedArn);
    expect(expectedArn).toMatch(/service-role\/AWSLambdaBasicExecutionRole$/);
  });

  it("IAM Role has permission boundary enforced (PowerUserAccess)", () => {
    // Tier C: strengthened — PowerUserAccess is the safety envelope used
    // by both lambda-with-exec-role and serverless-api per Wave 13 design;
    // assert the actual ARN, not just defined-ness, so a refactor that
    // accidentally drops the boundary or substitutes a weaker one fails CI.
    const roleOpts = serverlessApiPattern.defaultOptions["iam-execution-role"];
    expect(roleOpts?.["PermissionsBoundary"]).toBe(
      "arn:aws:iam::aws:policy/PowerUserAccess",
    );
  });

  it("HTTP API has CORS configuration", () => {
    // Tier C: strengthened — CorsConfiguration is a structured object
    // with AllowMethods/AllowHeaders arrays. Assert the shape so a
    // refactor that drops one of the arrays fails CI.
    const apiOpts = serverlessApiPattern.defaultOptions["http-api"];
    expect(apiOpts?.["ProtocolType"]).toBe("HTTP");
    const cors = apiOpts?.["CorsConfiguration"] as Record<string, unknown>;
    expect(cors).toMatchObject({
      AllowMethods: expect.any(Array),
      AllowHeaders: expect.any(Array),
    });
  });

  it("non-provisionable resources are correctly marked", () => {
    const provisionableMap = Object.fromEntries(
      serverlessApiPattern.resourceList.map((r) => [
        r.resourceId,
        r.provisionable,
      ]),
    );
    // IAM Role and Lambda are provisionable (default = true)
    expect(provisionableMap["iam-execution-role"]).not.toBe(false);
    expect(provisionableMap["lambda-fn"]).not.toBe(false);
    expect(provisionableMap["access-log-group"]).not.toBe(false);
    // API Gateway sub-resources are not provisionable via CloudControl
    expect(provisionableMap["http-api"]).toBe(false);
    expect(provisionableMap["lambda-integration"]).toBe(false);
    expect(provisionableMap["default-route"]).toBe(false);
    expect(provisionableMap["default-stage"]).toBe(false);
    expect(provisionableMap["api-invoke-permission"]).toBe(false);
  });
});

describe("Individual pattern data integrity", () => {
  it("messageProcessingPattern has DLQ before main-queue in dependencyOrder", () => {
    const dlqGroup = messageProcessingPattern.dependencyOrder[0];
    expect(dlqGroup).toContain("dlq");
    const mainQueueGroup = messageProcessingPattern.dependencyOrder[1];
    expect(mainQueueGroup).toContain("main-queue");
  });

  it("staticWebsitePattern is a 4-resource fully-CCAPI compound (S3 + OAC + CloudFront + BucketPolicy)", () => {
    // (f) 2026-04-09 Task 4b: the static-website compound now flows
    // entirely through CCAPI. CloudFront::Distribution,
    // CloudFront::OriginAccessControl, and S3::BucketPolicy are all
    // first-class resources, and the ~430 LOC cloudfront-setup.ts SDK
    // post-provision hook was deleted.
    expect(staticWebsitePattern.resourceList).toHaveLength(4);
    const typesInOrder = staticWebsitePattern.resourceList.map(
      (r) => r.resourceType,
    );
    expect(typesInOrder).toEqual([
      "AWS::S3::Bucket",
      "AWS::CloudFront::OriginAccessControl",
      "AWS::CloudFront::Distribution",
      "AWS::S3::BucketPolicy",
    ]);
    // Every resource is provisionable via CCAPI — no more
    // provisionable:false markers that would force a post-provision
    // SDK hook.
    for (const entry of staticWebsitePattern.resourceList) {
      expect(entry.provisionable).not.toBe(false);
    }
  });

  it("staticWebsitePattern dependency order enforces OAC-before-Distribution-before-BucketPolicy", () => {
    // Distribution needs the OAC Id in DistributionConfig, so OAC
    // must land first. BucketPolicy needs the Distribution ARN in
    // its aws:SourceArn condition, so it must land last.
    const order = staticWebsitePattern.dependencyOrder.flat();
    const oacIdx = order.indexOf("cdn-oac");
    const distIdx = order.indexOf("cdn-distribution");
    const policyIdx = order.indexOf("bucket-policy");
    const bucketIdx = order.indexOf("website-bucket");
    expect(oacIdx).toBeLessThan(distIdx);
    expect(distIdx).toBeLessThan(policyIdx);
    expect(bucketIdx).toBeLessThan(distIdx);
  });
});
