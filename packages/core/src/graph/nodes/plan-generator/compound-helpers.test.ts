/**
 * Unit tests for plan-generator/compound-helpers.ts.
 *
 * Focused on:
 *   - `filterElicitedForSlot` — the A-01 regression guard that prevents
 *     type-specific name fields (FunctionName, BucketName, …) from leaking
 *     across slots. See e96.W1.B1 (Epic 95 A-01 regression of Epic 94 R2).
 *   - `rewriteManagedPolicyArnsForPartition` — W-010 partition-aware ARN
 *     rewrite for AWS-managed policy ARNs in compound template defaultOptions.
 */
import { describe, it, expect } from "vitest";
import {
  RESOURCE_TYPES,
  CfnKey,
  AwsManagedPolicy,
  awsManagedPolicyArn,
} from "@/index.js";
import {
  filterElicitedForSlot,
  rewriteManagedPolicyArnsForPartition,
} from "./compound-helpers.js";

describe("filterElicitedForSlot", () => {
  it("drops FunctionName from a non-Lambda slot (the A-01 leak)", () => {
    const elicited = {
      [CfnKey.FUNCTION_NAME]: "my-fn",
    };
    const filtered = filterElicitedForSlot(elicited, RESOURCE_TYPES.IAM_ROLE);
    expect(filtered[CfnKey.FUNCTION_NAME]).toBeUndefined();
  });

  it("preserves FunctionName on the Lambda slot", () => {
    const elicited = {
      [CfnKey.FUNCTION_NAME]: "my-fn",
    };
    const filtered = filterElicitedForSlot(
      elicited,
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(filtered[CfnKey.FUNCTION_NAME]).toBe("my-fn");
  });

  it("drops BucketName from a non-S3 slot", () => {
    const elicited = { [CfnKey.BUCKET_NAME]: "my-bucket" };
    const filtered = filterElicitedForSlot(
      elicited,
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(filtered[CfnKey.BUCKET_NAME]).toBeUndefined();
  });

  it("preserves BucketName on the S3 slot", () => {
    const elicited = { [CfnKey.BUCKET_NAME]: "my-bucket" };
    const filtered = filterElicitedForSlot(elicited, RESOURCE_TYPES.S3_BUCKET);
    expect(filtered[CfnKey.BUCKET_NAME]).toBe("my-bucket");
  });

  it("preserves unbound keys (Handler, Runtime, MemorySize) on every slot", () => {
    // These are slot-specific Lambda CFN props but not registered as
    // name-fields — downstream CCAPI schema validation catches misuse.
    // The filter must NOT strip them.
    const elicited = {
      Handler: "index.handler",
      Runtime: "nodejs20.x",
      MemorySize: 512,
    };
    const forLambda = filterElicitedForSlot(
      elicited,
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const forRole = filterElicitedForSlot(elicited, RESOURCE_TYPES.IAM_ROLE);
    expect(forLambda).toEqual(elicited);
    expect(forRole).toEqual(elicited);
  });

  it("never mutates the input object", () => {
    const elicited = { [CfnKey.FUNCTION_NAME]: "my-fn", Runtime: "nodejs20.x" };
    const snapshot = { ...elicited };
    filterElicitedForSlot(elicited, RESOURCE_TYPES.IAM_ROLE);
    expect(elicited).toEqual(snapshot);
  });

  it("handles an empty elicitedOptions object", () => {
    expect(filterElicitedForSlot({}, RESOURCE_TYPES.IAM_ROLE)).toEqual({});
  });

  it("handles every cross-type pair (matrix of owned → foreign)", () => {
    // The eight bound name-fields. For each, assert that it only survives
    // on its owning resource type.
    const cases: Array<{ key: string; owner: string }> = [
      { key: CfnKey.FUNCTION_NAME, owner: RESOURCE_TYPES.LAMBDA_FUNCTION },
      { key: CfnKey.BUCKET_NAME, owner: RESOURCE_TYPES.S3_BUCKET },
      { key: CfnKey.ROLE_NAME, owner: RESOURCE_TYPES.IAM_ROLE },
      { key: CfnKey.QUEUE_NAME, owner: RESOURCE_TYPES.SQS_QUEUE },
      { key: CfnKey.TABLE_NAME, owner: RESOURCE_TYPES.DYNAMODB_TABLE },
      { key: CfnKey.TOPIC_NAME, owner: RESOURCE_TYPES.SNS_TOPIC },
      { key: "ClusterName", owner: RESOURCE_TYPES.ECS_CLUSTER },
      { key: "RepositoryName", owner: RESOURCE_TYPES.ECR_REPOSITORY },
      { key: "LogGroupName", owner: RESOURCE_TYPES.LOGS_LOG_GROUP },
    ];
    for (const { key, owner } of cases) {
      const elicited = { [key]: "val" };
      expect(filterElicitedForSlot(elicited, owner)[key]).toBe("val");
      // Against a foreign owner (pick any non-owner), the key must drop.
      const foreign =
        owner === RESOURCE_TYPES.IAM_ROLE
          ? RESOURCE_TYPES.LAMBDA_FUNCTION
          : RESOURCE_TYPES.IAM_ROLE;
      expect(filterElicitedForSlot(elicited, foreign)[key]).toBeUndefined();
    }
  });

  it("passes through the generic 'Name' key on every slot (unmapped by design)", () => {
    // "Name" is used by EventBridge Rule, ELBv2 LoadBalancer, and many
    // others. Cannot be attributed to one owner, so the filter leaves it
    // alone — CCAPI schema validation is the downstream enforcer.
    const elicited = { Name: "shared-name" };
    expect(
      filterElicitedForSlot(elicited, RESOURCE_TYPES.LAMBDA_FUNCTION)["Name"],
    ).toBe("shared-name");
    expect(
      filterElicitedForSlot(elicited, RESOURCE_TYPES.IAM_ROLE)["Name"],
    ).toBe("shared-name");
  });
});

/**
 * W-010 (Epic 99 Wave 4 Lane 4b): partition-aware managed policy ARN rewrite.
 *
 * Pattern templates store commercial-partition ARNs (`arn:aws:iam::aws:policy/...`)
 * in static `defaultOptions` objects. `rewriteManagedPolicyArnsForPartition`
 * runs at compound-plan time and replaces the commercial prefix with the
 * correct `arn:<partition>:iam::aws:policy/` for GovCloud, China, and ISO.
 */
describe("rewriteManagedPolicyArnsForPartition", () => {
  const COMMERCIAL_POWER_USER = "arn:aws:iam::aws:policy/PowerUserAccess";
  const COMMERCIAL_LAMBDA_EXEC =
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";

  describe("commercial partition — no-op fast path", () => {
    it("leaves PermissionsBoundary unchanged when partition is 'aws'", () => {
      const state = { PermissionsBoundary: COMMERCIAL_POWER_USER };
      rewriteManagedPolicyArnsForPartition(state, "aws");
      expect(state.PermissionsBoundary).toBe(COMMERCIAL_POWER_USER);
    });

    it("leaves ManagedPolicyArns unchanged when partition is 'aws'", () => {
      const state = { ManagedPolicyArns: [COMMERCIAL_LAMBDA_EXEC] };
      rewriteManagedPolicyArnsForPartition(state, "aws");
      expect(state.ManagedPolicyArns).toEqual([COMMERCIAL_LAMBDA_EXEC]);
    });
  });

  describe("GovCloud partition (aws-us-gov)", () => {
    it("rewrites PermissionsBoundary to aws-us-gov prefix", () => {
      const state: Record<string, unknown> = {
        PermissionsBoundary: COMMERCIAL_POWER_USER,
      };
      rewriteManagedPolicyArnsForPartition(state, "aws-us-gov");
      expect(state["PermissionsBoundary"]).toBe(
        awsManagedPolicyArn(
          "aws-us-gov",
          AwsManagedPolicy.POWER_USER_ACCESS_PATH,
        ),
      );
      expect(state["PermissionsBoundary"]).toMatch(
        /^arn:aws-us-gov:iam::aws:policy\//,
      );
    });

    it("rewrites ManagedPolicyArns array entries to aws-us-gov prefix", () => {
      const state: Record<string, unknown> = {
        ManagedPolicyArns: [COMMERCIAL_LAMBDA_EXEC],
      };
      rewriteManagedPolicyArnsForPartition(state, "aws-us-gov");
      expect(state["ManagedPolicyArns"]).toEqual([
        awsManagedPolicyArn(
          "aws-us-gov",
          AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
        ),
      ]);
    });

    it("rewrites multiple ARNs in ManagedPolicyArns", () => {
      const state: Record<string, unknown> = {
        ManagedPolicyArns: [COMMERCIAL_LAMBDA_EXEC, COMMERCIAL_POWER_USER],
      };
      rewriteManagedPolicyArnsForPartition(state, "aws-us-gov");
      const arns = state["ManagedPolicyArns"] as string[];
      expect(arns[0]).toBe(
        awsManagedPolicyArn(
          "aws-us-gov",
          AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
        ),
      );
      expect(arns[1]).toBe(
        awsManagedPolicyArn(
          "aws-us-gov",
          AwsManagedPolicy.POWER_USER_ACCESS_PATH,
        ),
      );
    });
  });

  describe("China partition (aws-cn)", () => {
    it("rewrites PermissionsBoundary to aws-cn prefix", () => {
      const state: Record<string, unknown> = {
        PermissionsBoundary: COMMERCIAL_POWER_USER,
      };
      rewriteManagedPolicyArnsForPartition(state, "aws-cn");
      expect(state["PermissionsBoundary"]).toMatch(
        /^arn:aws-cn:iam::aws:policy\//,
      );
    });
  });

  describe("ISO partition (aws-iso)", () => {
    it("rewrites PermissionsBoundary to aws-iso prefix", () => {
      const state: Record<string, unknown> = {
        PermissionsBoundary: COMMERCIAL_POWER_USER,
      };
      rewriteManagedPolicyArnsForPartition(state, "aws-iso");
      expect(state["PermissionsBoundary"]).toMatch(
        /^arn:aws-iso:iam::aws:policy\//,
      );
    });
  });

  describe("ISO-B partition (aws-iso-b)", () => {
    it("rewrites PermissionsBoundary to aws-iso-b prefix", () => {
      const state: Record<string, unknown> = {
        PermissionsBoundary: COMMERCIAL_POWER_USER,
      };
      rewriteManagedPolicyArnsForPartition(state, "aws-iso-b");
      expect(state["PermissionsBoundary"]).toMatch(
        /^arn:aws-iso-b:iam::aws:policy\//,
      );
    });
  });

  describe("non-managed-policy ARNs are not touched", () => {
    it("leaves non-commercial-managed-policy ARN in ManagedPolicyArns unchanged", () => {
      const customArn = "arn:aws:iam::123456789012:policy/MyCustomPolicy";
      const state: Record<string, unknown> = {
        ManagedPolicyArns: [customArn],
      };
      rewriteManagedPolicyArnsForPartition(state, "aws-us-gov");
      expect(state["ManagedPolicyArns"]).toEqual([customArn]);
    });

    it("leaves non-ARN values in ManagedPolicyArns unchanged", () => {
      const nonArn = "NotAnArn";
      const state: Record<string, unknown> = {
        ManagedPolicyArns: [nonArn],
      };
      rewriteManagedPolicyArnsForPartition(state, "aws-us-gov");
      expect(state["ManagedPolicyArns"]).toEqual([nonArn]);
    });
  });

  describe("absent fields are not created", () => {
    it("does not add PermissionsBoundary when absent", () => {
      const state: Record<string, unknown> = { SomeOtherField: "value" };
      rewriteManagedPolicyArnsForPartition(state, "aws-us-gov");
      expect(state["PermissionsBoundary"]).toBeUndefined();
    });

    it("does not add ManagedPolicyArns when absent", () => {
      const state: Record<string, unknown> = { SomeOtherField: "value" };
      rewriteManagedPolicyArnsForPartition(state, "aws-us-gov");
      expect(state["ManagedPolicyArns"]).toBeUndefined();
    });
  });
});
