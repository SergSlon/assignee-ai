/**
 * Wave 13 — tests for the lambda-with-exec-role pattern.
 *
 * Pins:
 *   - Pattern structure: 2 resources, IAM Role + Lambda, with marker
 *     token wiring the Lambda's Role field to the IAM Role's Arn
 *   - Keyword detection: matches plain "create a lambda" intents
 *   - Registration order disjointness: longer-form Lambda intents
 *     ("create a serverless api with lambda", "lambda function with
 *     api") still match the larger serverless-api pattern when both
 *     patterns are registered together in canonical order
 *   - Defaults: trust policy targets lambda.amazonaws.com, permissions
 *     boundary keeps the auto-created role inside PowerUserAccess
 */

import { describe, it, expect } from "vitest";
import { lambdaWithExecRolePattern } from "./lambda-with-exec-role.js";
import { serverlessApiPattern } from "./serverless-api.js";
import { messageProcessingPattern } from "./message-processing.js";
import { PatternRegistry } from "../registry.js";
import { PatternId } from "../pattern-ids.js";
import { LambdaWithExecRoleResourceId as R } from "../pattern-resource-ids.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import {
  AwsServicePrincipal,
  AwsManagedPolicy,
  awsManagedPolicyArn,
} from "../../config/aws-arns.js";
import { rewriteManagedPolicyArnsForPartition } from "../../graph/nodes/plan-generator/compound-helpers.js";

describe("lambdaWithExecRolePattern — structure", () => {
  it("has the expected patternId from PatternId.LAMBDA_WITH_EXEC_ROLE", () => {
    expect(lambdaWithExecRolePattern.patternId).toBe(
      PatternId.LAMBDA_WITH_EXEC_ROLE,
    );
  });

  it("declares exactly 2 resources: IAM Role then Lambda", () => {
    expect(lambdaWithExecRolePattern.resourceList).toHaveLength(2);
    expect(lambdaWithExecRolePattern.resourceList[0]!.resourceType).toBe(
      RESOURCE_TYPES.IAM_ROLE,
    );
    expect(lambdaWithExecRolePattern.resourceList[0]!.resourceId).toBe(
      R.IAM_EXECUTION_ROLE,
    );
    expect(lambdaWithExecRolePattern.resourceList[1]!.resourceType).toBe(
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(lambdaWithExecRolePattern.resourceList[1]!.resourceId).toBe(
      R.LAMBDA_FN,
    );
  });

  it("declares dependencyOrder so the IAM Role provisions before the Lambda", () => {
    expect(lambdaWithExecRolePattern.dependencyOrder).toEqual([
      [R.IAM_EXECUTION_ROLE],
      [R.LAMBDA_FN],
    ]);
  });

  it("has non-empty defaultOptions for both resources", () => {
    // Tier C: strengthened — assert keys count > 0, not just defined
    const roleOpts = lambdaWithExecRolePattern.defaultOptions[
      R.IAM_EXECUTION_ROLE
    ] as Record<string, unknown>;
    const lambdaOpts = lambdaWithExecRolePattern.defaultOptions[
      R.LAMBDA_FN
    ] as Record<string, unknown>;
    expect(Object.keys(roleOpts).length).toBeGreaterThan(0);
    expect(Object.keys(lambdaOpts).length).toBeGreaterThan(0);
  });

  it("IAM Role default has the canonical Lambda trust policy", () => {
    const role = lambdaWithExecRolePattern.defaultOptions[
      R.IAM_EXECUTION_ROLE
    ] as Record<string, unknown>;
    const trust = role["AssumeRolePolicyDocument"] as {
      Statement: Array<{ Principal: { Service: string } }>;
    };
    expect(trust.Statement[0]!.Principal.Service).toBe(
      AwsServicePrincipal.LAMBDA,
    );
  });

  it("IAM Role default applies the PowerUserAccess permissions boundary (commercial partition)", () => {
    const role = lambdaWithExecRolePattern.defaultOptions[
      R.IAM_EXECUTION_ROLE
    ] as Record<string, unknown>;
    expect(role["PermissionsBoundary"]).toBe(
      awsManagedPolicyArn("aws", AwsManagedPolicy.POWER_USER_ACCESS_PATH),
    );
  });

  it("rewriteManagedPolicyArnsForPartition rewrites PermissionsBoundary to GovCloud partition (W-010)", () => {
    // Clone the static defaultOptions slot so we don't mutate the shared pattern object.
    const roleSlot = {
      ...(lambdaWithExecRolePattern.defaultOptions[
        R.IAM_EXECUTION_ROLE
      ] as Record<string, unknown>),
    };
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

  it("Lambda default Role field is a marker token referencing the IAM Role's Arn", () => {
    const lambda = lambdaWithExecRolePattern.defaultOptions[
      R.LAMBDA_FN
    ] as Record<string, unknown>;
    const roleField = String(lambda["Role"]);
    // Marker tokens have the form __ASSIGNEE_GETATT_<resourceId>_<attr>__
    expect(roleField).toContain("__ASSIGNEE_GETATT_");
    expect(roleField).toContain(R.IAM_EXECUTION_ROLE);
    expect(roleField).toContain("Arn");
  });
});

describe("lambdaWithExecRolePattern — keyword detection", () => {
  function freshRegistry(): PatternRegistry {
    // Canonical registration order — serverless-api FIRST so it gets
    // first crack at longer-form Lambda intents.
    const r = new PatternRegistry();
    r.register(serverlessApiPattern);
    r.register(messageProcessingPattern);
    r.register(lambdaWithExecRolePattern);
    return r;
  }

  it("matches plain 'create a lambda' intents", () => {
    const registry = freshRegistry();
    expect(registry.detect("create a lambda")).toBe(lambdaWithExecRolePattern);
    expect(registry.detect("create a lambda function")).toBe(
      lambdaWithExecRolePattern,
    );
    expect(registry.detect("Deploy a Lambda for me")).toBe(
      lambdaWithExecRolePattern,
    );
  });

  it("matches language-specific Lambda intents", () => {
    const registry = freshRegistry();
    expect(registry.detect("create a node lambda for image processing")).toBe(
      lambdaWithExecRolePattern,
    );
    expect(registry.detect("python function that resizes images")).toBe(
      lambdaWithExecRolePattern,
    );
  });

  it("matches background-worker / scheduled-task intents", () => {
    const registry = freshRegistry();
    expect(registry.detect("set up a background worker")).toBe(
      lambdaWithExecRolePattern,
    );
    expect(
      registry.detect("create a scheduled lambda for nightly cleanup"),
    ).toBe(lambdaWithExecRolePattern);
  });

  it("matches 'create a function' (catch-all wording)", () => {
    const registry = freshRegistry();
    expect(registry.detect("create a function")).toBe(
      lambdaWithExecRolePattern,
    );
    expect(registry.detect("deploy a function that sends emails")).toBe(
      lambdaWithExecRolePattern,
    );
  });
});

describe("lambdaWithExecRolePattern — disjointness from larger Lambda patterns", () => {
  function freshRegistry(): PatternRegistry {
    const r = new PatternRegistry();
    r.register(serverlessApiPattern);
    r.register(messageProcessingPattern);
    r.register(lambdaWithExecRolePattern);
    return r;
  }

  // Wave 13: critical contract — longer-form Lambda intents must STILL
  // match the bigger pattern when both are registered. Otherwise users
  // who say "create a serverless api with lambda" would get a 2-resource
  // plan (just Lambda + Role) instead of the full 8-resource API stack.
  it("'create a serverless api' still matches serverless-api, not lambda-with-exec-role", () => {
    const registry = freshRegistry();
    expect(registry.detect("create a serverless api")).toBe(
      serverlessApiPattern,
    );
  });

  it("'lambda function with api' still matches serverless-api", () => {
    const registry = freshRegistry();
    expect(registry.detect("create a lambda function with api gateway")).toBe(
      serverlessApiPattern,
    );
  });

  it("'rest api with lambda' still matches serverless-api", () => {
    const registry = freshRegistry();
    expect(registry.detect("build a rest api with lambda")).toBe(
      serverlessApiPattern,
    );
  });

  it("'http api lambda' still matches serverless-api", () => {
    const registry = freshRegistry();
    expect(registry.detect("set up http api lambda")).toBe(
      serverlessApiPattern,
    );
  });

  it("'sqs lambda' still matches message-processing", () => {
    const registry = freshRegistry();
    expect(registry.detect("create sqs lambda processor")).toBe(
      messageProcessingPattern,
    );
  });

  it("'message queue with lambda' still matches message-processing", () => {
    const registry = freshRegistry();
    expect(registry.detect("set up message queue with lambda")).toBe(
      messageProcessingPattern,
    );
  });
});

describe("default pattern registry — Wave 13 integration", () => {
  it("the exported defaultPatternRegistry returns lambda-with-exec-role for plain Lambda intents", async () => {
    // Use the actual default registry — verifies the pattern is wired
    // through index.ts and registered in the right order.
    const { defaultPatternRegistry } = await import("../index.js");
    expect(defaultPatternRegistry.detect("create a lambda")).toBe(
      lambdaWithExecRolePattern,
    );
  });

  it("the default registry still routes longer-form Lambda intents to serverless-api", async () => {
    const { defaultPatternRegistry } = await import("../index.js");
    expect(defaultPatternRegistry.detect("create a serverless api")).toBe(
      serverlessApiPattern,
    );
    expect(defaultPatternRegistry.detect("rest api with lambda")).toBe(
      serverlessApiPattern,
    );
  });

  it("the default registry includes lambda-with-exec-role under its patternId", async () => {
    const { defaultPatternRegistry } = await import("../index.js");
    expect(defaultPatternRegistry.has(PatternId.LAMBDA_WITH_EXEC_ROLE)).toBe(
      true,
    );
    expect(defaultPatternRegistry.get(PatternId.LAMBDA_WITH_EXEC_ROLE)).toBe(
      lambdaWithExecRolePattern,
    );
  });
});
