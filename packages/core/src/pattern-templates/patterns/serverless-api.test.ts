import { describe, it, expect } from "vitest";
import { serverlessApiPattern } from "./serverless-api.js";
import { threeTierWebPattern } from "./three-tier-web.js";
import { containerServicePattern } from "./container-service.js";
import { messageProcessingPattern } from "./message-processing.js";
import { staticWebsitePattern } from "./static-website.js";
import { PatternRegistry } from "../registry.js";

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
    const routeOpts = serverlessApiPattern.defaultOptions["default-route"];
    expect(routeOpts?.["ApiId"]).toBe("__ASSIGNEE_REF_http-api__");
    expect(routeOpts?.["Target"]).toBeDefined();
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
    const permOpts =
      serverlessApiPattern.defaultOptions["api-invoke-permission"];
    expect(permOpts?.["FunctionName"]).toBe(
      "__ASSIGNEE_GETATT_lambda-fn_Arn__",
    );
    expect(permOpts?.["Principal"]).toBe("apigateway.amazonaws.com");
    expect(permOpts?.["SourceArn"]).toBeDefined();
  });

  it("emits no CloudFormation intrinsics in defaultOptions", () => {
    // CloudControl API does not process Fn::* or { Ref } — compound patterns
    // must use marker tokens that the plan-generator resolves at runtime.
    const serialized = JSON.stringify(serverlessApiPattern.defaultOptions);
    expect(serialized).not.toMatch(/"Fn::/);
    expect(serialized).not.toMatch(/"Ref":/);
  });

  it("IAM Role has permission boundary enforced", () => {
    const roleOpts = serverlessApiPattern.defaultOptions["iam-execution-role"];
    expect(roleOpts?.["PermissionsBoundary"]).toBeDefined();
  });

  it("HTTP API has CORS configuration", () => {
    const apiOpts = serverlessApiPattern.defaultOptions["http-api"];
    expect(apiOpts?.["CorsConfiguration"]).toBeDefined();
    expect(apiOpts?.["ProtocolType"]).toBe("HTTP");
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

  it("staticWebsitePattern includes S3 bucket + CloudFront + OAC", () => {
    expect(staticWebsitePattern.resourceList).toHaveLength(3);
    expect(staticWebsitePattern.resourceList[0]?.resourceType).toBe(
      "AWS::S3::Bucket",
    );
    expect(staticWebsitePattern.resourceList[1]?.resourceType).toBe(
      "AWS::CloudFront::Distribution",
    );
    expect(staticWebsitePattern.resourceList[1]?.provisionable).toBe(false);
    expect(staticWebsitePattern.resourceList[2]?.resourceType).toBe(
      "AWS::CloudFront::OriginAccessControl",
    );
    expect(staticWebsitePattern.resourceList[2]?.provisionable).toBe(false);
  });
});
