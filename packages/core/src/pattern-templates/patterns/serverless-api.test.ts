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
});

describe("Individual pattern data integrity", () => {
  it("serverlessApiPattern has correct patternId", () => {
    expect(serverlessApiPattern.patternId).toBe("serverless-api");
  });

  it("serverlessApiPattern defaultOptions uses bracket notation safely", () => {
    expect(serverlessApiPattern.defaultOptions["lambda-fn"]).toBeDefined();
    expect(
      serverlessApiPattern.defaultOptions["iam-execution-role"],
    ).toBeDefined();
  });

  it("messageProcessingPattern has DLQ before main-queue in dependencyOrder", () => {
    const dlqGroup = messageProcessingPattern.dependencyOrder[0];
    expect(dlqGroup).toContain("dlq");
    const mainQueueGroup = messageProcessingPattern.dependencyOrder[1];
    expect(mainQueueGroup).toContain("main-queue");
  });

  it("staticWebsitePattern only includes S3 bucket for MVP", () => {
    expect(staticWebsitePattern.resourceList).toHaveLength(1);
    expect(staticWebsitePattern.resourceList[0]?.resourceType).toBe(
      "AWS::S3::Bucket",
    );
  });
});
