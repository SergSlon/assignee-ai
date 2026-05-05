/**
 * Unit tests for plan-generator/compound-helpers.ts.
 *
 * Focused on:
 *   - `filterElicitedForSlot` — the A-01 regression guard that prevents
 *     type-specific name fields (FunctionName, BucketName, …) from leaking
 *     across slots. See e96.W1.B1 (Epic 95 A-01 regression of Epic 94 R2).
 *   - `rewriteManagedPolicyArnsForPartition` — W-010 partition-aware ARN
 *     rewrite for AWS-managed policy ARNs in compound template defaultOptions.
 *   - `postProcessEc2Compound` SSH-bundle Windows fail-fast — Story iii
 *     guards against `assignee apply "Create a Windows EC2 with SSH"` by
 *     throwing `AssigneeError(WINDOWS_SSH_INCOMPATIBLE)` BEFORE wizard
 *     rendering / keypair creation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RESOURCE_TYPES,
  CfnKey,
  AwsManagedPolicy,
  ResourceDefault,
  AssigneeError,
  awsManagedPolicyArn,
} from "@/index.js";

vi.mock("@/utils/aws-resource-discovery/ami-default-user.js", async () => {
  const actual = await vi.importActual<
    typeof import("@/utils/aws-resource-discovery/ami-default-user.js")
  >("@/utils/aws-resource-discovery/ami-default-user.js");
  return {
    ...actual,
    getAmiPlatformDetails: vi.fn(),
  };
});

import {
  filterElicitedForSlot,
  rewriteManagedPolicyArnsForPartition,
  postProcessEc2Compound,
  WINDOWS_SSH_INCOMPATIBLE_CODE,
} from "./compound-helpers.js";
import {
  getAmiPlatformDetails,
  PLATFORM_DETAILS_WINDOWS,
} from "@/utils/aws-resource-discovery/ami-default-user.js";

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

// ── postProcessEc2Compound — Story iii Windows SSH fail-fast ─────────────────

describe("postProcessEc2Compound — SSH-bundle Windows fail-fast", () => {
  const AMI_LINUX = "ami-0abcdef1234567890";
  const AMI_WINDOWS = "ami-0d1e2f3a4b5c6d7e8";
  const ec2Resource = {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    resourceId: "ec2-1",
    displayName: "EC2 instance ec2-1",
  } as const;

  beforeEach(() => {
    vi.mocked(getAmiPlatformDetails).mockReset();
  });

  it("Linux AMI + SSH intent: passes through, injects KeyName placeholder", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce("Linux/UNIX");
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: AMI_LINUX,
    };

    await postProcessEc2Compound(
      desiredState,
      ec2Resource,
      "Create an EC2 with SSH access",
    );

    expect(getAmiPlatformDetails).toHaveBeenCalledWith(AMI_LINUX);
    expect(desiredState[CfnKey.KEY_NAME]).toBe(
      ResourceDefault.SSH_KEY_PLACEHOLDER,
    );
  });

  it("Windows AMI + SSH intent: throws AssigneeError(WINDOWS_SSH_INCOMPATIBLE) and does NOT inject KeyName", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce(
      PLATFORM_DETAILS_WINDOWS,
    );
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: AMI_WINDOWS,
    };

    await expect(
      postProcessEc2Compound(
        desiredState,
        ec2Resource,
        "Create a Windows EC2 with SSH",
      ),
    ).rejects.toBeInstanceOf(AssigneeError);

    // Re-run to capture the message + code on the rejected promise.
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce(
      PLATFORM_DETAILS_WINDOWS,
    );
    await expect(
      postProcessEc2Compound(
        desiredState,
        ec2Resource,
        "Create a Windows EC2 with SSH",
      ),
    ).rejects.toMatchObject({
      code: WINDOWS_SSH_INCOMPATIBLE_CODE,
      message: expect.stringContaining(
        "Cannot create EC2 with SSH on a Windows AMI",
      ),
    });

    // The fail-fast must run BEFORE the KeyName placeholder injection,
    // i.e. desiredState is left untouched.
    expect(desiredState[CfnKey.KEY_NAME]).toBeUndefined();
  });

  it("Windows AMI + non-SSH intent: passes through, no AMI lookup, no error", async () => {
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: AMI_WINDOWS,
    };

    await postProcessEc2Compound(
      desiredState,
      ec2Resource,
      "Create a Windows EC2 for batch processing",
    );

    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
    expect(desiredState[CfnKey.KEY_NAME]).toBeUndefined();
  });

  it("SSH intent + AMI lookup returns null (transient API blip): passes through to KeyName injection (assume non-Windows)", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce(null);
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: AMI_LINUX,
    };

    await postProcessEc2Compound(
      desiredState,
      ec2Resource,
      "Create an EC2 with SSH",
    );

    expect(desiredState[CfnKey.KEY_NAME]).toBe(
      ResourceDefault.SSH_KEY_PLACEHOLDER,
    );
  });

  it("SSH intent + ImageId still an OS-name placeholder (not yet resolved): no AMI lookup, KeyName injected", async () => {
    // Defense-in-depth: compound-plan.ts:148-162 resolves OS names to
    // ami-* before postProcessEc2Compound runs, but if some path
    // missed resolution we must NOT pass an OS-name string to
    // getAmiPlatformDetails (it would call DescribeImages with garbage).
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: "amazon-linux-2023",
    };

    await postProcessEc2Compound(
      desiredState,
      ec2Resource,
      "Create EC2 with SSH",
    );

    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
    expect(desiredState[CfnKey.KEY_NAME]).toBe(
      ResourceDefault.SSH_KEY_PLACEHOLDER,
    );
  });

  it("non-EC2 resource: no SSH guard runs", async () => {
    const desiredState: Record<string, unknown> = {};
    await postProcessEc2Compound(
      desiredState,
      {
        resourceType: RESOURCE_TYPES.S3_BUCKET,
        resourceId: "s3-1",
        displayName: "S3 bucket s3-1",
      } as const,
      "Create EC2 with SSH",
    );
    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
  });

  it("preserves the existing SecurityGroupIds scrub semantics on Linux/SSH path", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce("Linux/UNIX");
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: AMI_LINUX,
      [CfnKey.SECURITY_GROUP_IDS]: ["sg-12345678", "not-a-real-sg", ""],
    };

    await postProcessEc2Compound(
      desiredState,
      ec2Resource,
      "Create an EC2 with SSH",
    );

    expect(desiredState[CfnKey.SECURITY_GROUP_IDS]).toEqual(["sg-12345678"]);
  });
});
