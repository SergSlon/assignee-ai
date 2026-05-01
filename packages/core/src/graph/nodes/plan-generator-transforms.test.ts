import { describe, it, expect, beforeEach } from "vitest";
import {
  ExecutionStatus,
  RESOURCE_TYPES,
  markerRef,
  markerAz,
  markerGetAtt,
  EIP_AUTO_ALLOCATE,
} from "../../index.js";
import {
  applyToCfnTransforms,
  resolveCompoundMarkers,
  __resetAzCacheForTests,
  isTemplatePlaceholder,
  collectPluginPlaceholders,
  stripPlaceholderArns,
} from "./plan-generator.js";

// ── Story 18.9: toCfn transform tests ────────────────────────────────────────

describe("applyToCfnTransforms", () => {
  it("transforms S3 boolean options into CFN structures", () => {
    const result = applyToCfnTransforms(
      {
        BucketEncryption: true,
        PublicAccessBlockConfiguration: true,
        VersioningConfiguration: true,
      },
      "AWS::S3::Bucket",
    );

    expect(result["BucketEncryption"]).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
    expect(result["PublicAccessBlockConfiguration"]).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(result["VersioningConfiguration"]).toEqual({ Status: "Enabled" });
  });

  it("omits fields where toCfn returns undefined (user said no)", () => {
    const result = applyToCfnTransforms(
      {
        BucketEncryption: false,
        PublicAccessBlockConfiguration: false,
        VersioningConfiguration: false,
      },
      "AWS::S3::Bucket",
    );

    expect(result["BucketEncryption"]).toBeUndefined();
    expect(result["PublicAccessBlockConfiguration"]).toBeUndefined();
    expect(result["VersioningConfiguration"]).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("passes through fields without toCfn unchanged", () => {
    const result = applyToCfnTransforms(
      { BucketName: "test-data-bucket", BucketEncryption: true },
      "AWS::S3::Bucket",
    );

    expect(result["BucketName"]).toBe("test-data-bucket");
    expect(result["BucketEncryption"]).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
  });

  it("returns options unchanged when plugin is not found", () => {
    const options = { SomeField: "some-value" };
    const result = applyToCfnTransforms(options, "AWS::Unknown::Resource");

    expect(result).toEqual(options);
  });

  it("transforms advanced fields (Lifecycle, CORS sub-fields → CFN structures)", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
        LifecycleTransitionDays: "30",
        EnableCors: true,
        CorsAllowedOrigins: "*",
        CorsAllowedMethods: "GET",
      },
      "AWS::S3::Bucket",
    );

    expect(result["LifecycleConfiguration"]).toEqual({
      Rules: [
        {
          Id: "assignee-default-lifecycle",
          Status: "Enabled",
          Transitions: [{ StorageClass: "STANDARD_IA", TransitionInDays: 30 }],
        },
      ],
    });
    expect(result["CorsConfiguration"]).toEqual({
      CorsRules: [
        {
          AllowedHeaders: ["*"],
          AllowedMethods: ["GET"],
          AllowedOrigins: ["*"],
        },
      ],
    });
    // Intermediate keys must be removed
    expect(result["EnableLifecycle"]).toBeUndefined();
    expect(result["EnableCors"]).toBeUndefined();
    expect(result["LifecycleTransitionDays"]).toBeUndefined();
    expect(result["CorsAllowedOrigins"]).toBeUndefined();
    expect(result["CorsAllowedMethods"]).toBeUndefined();
  });

  // ── M-R9: parseInt() || default swallows user-entered "0" ────────────────
  // Previously `parseInt(...) || 30` returned 30 when the user typed "0",
  // silently ignoring the user's deliberate immediate-transition request.
  // The fix uses `Number.isFinite(n) && n >= 0` to honor a 0 input.
  it("honors LifecycleTransitionDays = '0' (M-R9 — does not silently default to 30)", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
        LifecycleTransitionDays: "0",
      },
      "AWS::S3::Bucket",
    );

    const lifecycle = result["LifecycleConfiguration"] as {
      Rules: Array<{
        Transitions: Array<{ TransitionInDays: number; StorageClass: string }>;
      }>;
    };
    expect(lifecycle.Rules[0]!.Transitions[0]!.TransitionInDays).toBe(0);
  });

  it("falls back to 30 days when LifecycleTransitionDays is non-numeric", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
        LifecycleTransitionDays: "not-a-number",
      },
      "AWS::S3::Bucket",
    );
    const lifecycle = result["LifecycleConfiguration"] as {
      Rules: Array<{
        Transitions: Array<{ TransitionInDays: number }>;
      }>;
    };
    expect(lifecycle.Rules[0]!.Transitions[0]!.TransitionInDays).toBe(30);
  });

  it("falls back to 30 days when LifecycleTransitionDays is omitted entirely", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
      },
      "AWS::S3::Bucket",
    );
    const lifecycle = result["LifecycleConfiguration"] as {
      Rules: Array<{
        Transitions: Array<{ TransitionInDays: number }>;
      }>;
    };
    expect(lifecycle.Rules[0]!.Transitions[0]!.TransitionInDays).toBe(30);
  });

  // ── V1 PARTIAL: LifecycleExpirationDays sister-bug ─────────────────────
  // The transition-days fix used Number.isFinite, but the expiration-days
  // parser still used the `parseInt(...) ?` antipattern. Non-numeric input
  // silently became `undefined`. After the fix non-numeric input is still
  // dropped (no expiration emitted) but the *path* is explicit and a future
  // change can branch on it.
  it("emits ExpirationInDays when LifecycleExpirationDays > transition", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
        LifecycleTransitionDays: "30",
        LifecycleExpirationDays: "365",
      },
      "AWS::S3::Bucket",
    );
    const lifecycle = result["LifecycleConfiguration"] as {
      Rules: Array<{
        ExpirationInDays?: number;
        Transitions: Array<{ TransitionInDays: number }>;
      }>;
    };
    expect(lifecycle.Rules[0]!.ExpirationInDays).toBe(365);
  });

  it("clamps ExpirationInDays to transition+1 when input is too small", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
        LifecycleTransitionDays: "30",
        LifecycleExpirationDays: "10",
      },
      "AWS::S3::Bucket",
    );
    const lifecycle = result["LifecycleConfiguration"] as {
      Rules: Array<{ ExpirationInDays?: number }>;
    };
    expect(lifecycle.Rules[0]!.ExpirationInDays).toBe(31);
  });

  it("treats non-numeric LifecycleExpirationDays as 'no expiration' (V1 sister-bug)", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
        LifecycleTransitionDays: "30",
        LifecycleExpirationDays: "not-a-number",
      },
      "AWS::S3::Bucket",
    );
    const lifecycle = result["LifecycleConfiguration"] as {
      Rules: Array<{ ExpirationInDays?: number }>;
    };
    // Parser yields undefined → no ExpirationInDays key emitted.
    expect(lifecycle.Rules[0]!.ExpirationInDays).toBeUndefined();
  });

  it("treats LifecycleExpirationDays = '0' as no expiration (AWS rejects 0-day)", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
        LifecycleTransitionDays: "30",
        LifecycleExpirationDays: "0",
      },
      "AWS::S3::Bucket",
    );
    const lifecycle = result["LifecycleConfiguration"] as {
      Rules: Array<{ ExpirationInDays?: number }>;
    };
    // 0 is parsed (Number.isFinite passes), but the downstream `> 0` guard
    // skips the ExpirationInDays emission.
    expect(lifecycle.Rules[0]!.ExpirationInDays).toBeUndefined();
  });

  it("treats LifecycleExpirationDays = '   ' (whitespace only) as undefined", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
        LifecycleTransitionDays: "30",
        LifecycleExpirationDays: "   ",
      },
      "AWS::S3::Bucket",
    );
    const lifecycle = result["LifecycleConfiguration"] as {
      Rules: Array<{ ExpirationInDays?: number }>;
    };
    expect(lifecycle.Rules[0]!.ExpirationInDays).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveCompoundMarkers — the VPC-compound apply fix
// ─────────────────────────────────────────────────────────────────────────
//
// CloudControl API does NOT process CloudFormation intrinsics, so compound
// patterns cannot emit { Fn::Select, Fn::GetAZs }, { Ref: ... }, or
// { Fn::GetAtt: ... } objects directly in defaultOptions. Instead, patterns
// emit marker-token STRINGS that this resolver substitutes with concrete
// values before the plan reaches CloudControl.
describe("resolveCompoundMarkers — VPC compound apply fix", () => {
  beforeEach(() => {
    __resetAzCacheForTests();
  });

  // Real-shaped AZ fixture — exactly what DescribeAvailabilityZones returns
  // for us-east-1. We pin to real AZ names so a regression that quietly
  // passes a placeholder through would be immediately visible.
  const realUsEast1Azs = [
    "us-east-1a",
    "us-east-1b",
    "us-east-1c",
    "us-east-1d",
    "us-east-1e",
    "us-east-1f",
  ];

  it("substitutes __ASSIGNEE_REF_<id>__ with the completed resource's physical ID", async () => {
    const desiredState: Record<string, unknown> = {
      VpcId: markerRef("vpc"),
      CidrBlock: "10.0.1.0/24",
    };

    await resolveCompoundMarkers(desiredState, {
      completedResources: [
        {
          resourceId: "vpc",
          resourceType: RESOURCE_TYPES.EC2_VPC,
          resourceArn: "vpc-0abc123def456789",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      region: "us-east-1",
      currentResourceId: "public-subnet-1",
      azLookup: async () => realUsEast1Azs,
    });

    expect(desiredState).toEqual({
      VpcId: "vpc-0abc123def456789",
      CidrBlock: "10.0.1.0/24",
    });
  });

  it("substitutes __ASSIGNEE_AZ_<n>__ with the Nth availability zone name", async () => {
    const desiredState: Record<string, unknown> = {
      AvailabilityZone: markerAz(0),
      CidrBlock: "10.0.1.0/24",
    };

    await resolveCompoundMarkers(desiredState, {
      completedResources: [],
      region: "us-east-1",
      currentResourceId: "public-subnet-1",
      azLookup: async () => realUsEast1Azs,
    });

    expect(desiredState["AvailabilityZone"]).toBe("us-east-1a");
  });

  it("resolves different AZ indices in a single state to different zones", async () => {
    const desiredState: Record<string, unknown> = {
      first: markerAz(0),
      second: markerAz(1),
      third: markerAz(2),
    };

    await resolveCompoundMarkers(desiredState, {
      completedResources: [],
      region: "us-east-1",
      currentResourceId: "public-subnet-2",
      azLookup: async () => realUsEast1Azs,
    });

    expect(desiredState).toEqual({
      first: "us-east-1a",
      second: "us-east-1b",
      third: "us-east-1c",
    });
  });

  it("caches AZ lookup — only one call per resolver invocation regardless of marker count", async () => {
    const desiredState: Record<string, unknown> = {
      az1: markerAz(0),
      az2: markerAz(1),
      az3: markerAz(0), // duplicate
      nested: { az4: markerAz(1) },
    };
    let lookupCalls = 0;
    await resolveCompoundMarkers(desiredState, {
      completedResources: [],
      region: "us-east-1",
      currentResourceId: "public-subnet-1",
      azLookup: async () => {
        lookupCalls += 1;
        return realUsEast1Azs;
      },
    });
    expect(lookupCalls).toBe(1);
  });

  it("substitutes __ASSIGNEE_GETATT_<id>_<attr>__ with the resource's primary identifier", async () => {
    const desiredState: Record<string, unknown> = {
      Role: markerGetAtt("iam-execution-role", "Arn"),
    };

    await resolveCompoundMarkers(desiredState, {
      completedResources: [
        {
          resourceId: "iam-execution-role",
          resourceType: RESOURCE_TYPES.IAM_ROLE,
          resourceArn:
            "arn:aws:iam::123456789012:role/assignee-iam-execution-role-run1234",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      region: "us-east-1",
      currentResourceId: "lambda-fn",
      azLookup: async () => realUsEast1Azs,
    });

    expect(desiredState["Role"]).toBe(
      "arn:aws:iam::123456789012:role/assignee-iam-execution-role-run1234",
    );
  });

  it("walks nested objects and arrays — VPC subnet+tag structure", async () => {
    // Real-shaped: a subnet with a Tag array containing a marker value.
    const desiredState: Record<string, unknown> = {
      VpcId: markerRef("vpc"),
      AvailabilityZone: markerAz(0),
      CidrBlock: "10.0.1.0/24",
      Tags: [
        { Key: "Name", Value: "public-subnet-1" },
        { Key: "VpcRef", Value: markerRef("vpc") },
      ],
    };

    await resolveCompoundMarkers(desiredState, {
      completedResources: [
        {
          resourceId: "vpc",
          resourceType: RESOURCE_TYPES.EC2_VPC,
          resourceArn: "vpc-0abc123def456789",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      region: "us-east-1",
      currentResourceId: "public-subnet-1",
      azLookup: async () => realUsEast1Azs,
    });

    expect(desiredState).toEqual({
      VpcId: "vpc-0abc123def456789",
      AvailabilityZone: "us-east-1a",
      CidrBlock: "10.0.1.0/24",
      Tags: [
        { Key: "Name", Value: "public-subnet-1" },
        { Key: "VpcRef", Value: "vpc-0abc123def456789" },
      ],
    });
  });

  it("leaves non-marker strings untouched", async () => {
    const desiredState: Record<string, unknown> = {
      CidrBlock: "10.0.1.0/24",
      Name: "my-vpc",
      AllocationId: EIP_AUTO_ALLOCATE, // a sentinel the provisioner handles, not a marker
    };
    await resolveCompoundMarkers(desiredState, {
      completedResources: [],
      region: "us-east-1",
      currentResourceId: "nat-gateway",
      azLookup: async () => realUsEast1Azs,
    });
    expect(desiredState).toEqual({
      CidrBlock: "10.0.1.0/24",
      Name: "my-vpc",
      AllocationId: EIP_AUTO_ALLOCATE,
    });
  });

  it("fails with a descriptive error when REF target is not in completedResources", async () => {
    const desiredState: Record<string, unknown> = {
      VpcId: markerRef("vpc"),
    };
    await expect(
      resolveCompoundMarkers(desiredState, {
        completedResources: [], // empty — vpc missing
        region: "us-east-1",
        currentResourceId: "public-subnet-1",
        azLookup: async () => realUsEast1Azs,
      }),
    ).rejects.toThrow(/no completed resource with resourceId "vpc"/);
  });

  it("fails with a descriptive error when REF target has undefined resourceArn", async () => {
    const desiredState: Record<string, unknown> = {
      VpcId: markerRef("vpc"),
    };
    await expect(
      resolveCompoundMarkers(desiredState, {
        completedResources: [
          {
            resourceId: "vpc",
            resourceType: RESOURCE_TYPES.EC2_VPC,
            resourceArn: undefined,
            executionStatus: ExecutionStatus.SUCCESS,
          },
        ],
        region: "us-east-1",
        currentResourceId: "public-subnet-1",
        azLookup: async () => realUsEast1Azs,
      }),
    ).rejects.toThrow(/completed without a physical identifier/);
  });

  it("fails with a descriptive error when AZ index exceeds available zones", async () => {
    const desiredState: Record<string, unknown> = {
      AvailabilityZone: markerAz(10),
    };
    await expect(
      resolveCompoundMarkers(desiredState, {
        completedResources: [],
        region: "us-east-1",
        currentResourceId: "public-subnet-1",
        azLookup: async () => ["us-east-1a", "us-east-1b"], // only 2 zones
      }),
    ).rejects.toThrow(/AZ index 10 is out of range/);
  });

  it("resolves a realistic full VPC-pattern subnet state end-to-end", async () => {
    // This mirrors exactly what vpc-networking.ts emits for public-subnet-1
    // after applyToCfnTransforms in the compound plan-generator branch.
    const desiredState: Record<string, unknown> = {
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: markerAz(0),
      MapPublicIpOnLaunch: true,
      VpcId: markerRef("vpc"),
    };

    await resolveCompoundMarkers(desiredState, {
      completedResources: [
        {
          resourceId: "vpc",
          resourceType: RESOURCE_TYPES.EC2_VPC,
          resourceArn: "vpc-0abc123def456789",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      region: "us-east-1",
      currentResourceId: "public-subnet-1",
      azLookup: async () => realUsEast1Azs,
    });

    expect(desiredState).toEqual({
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: "us-east-1a",
      MapPublicIpOnLaunch: true,
      VpcId: "vpc-0abc123def456789",
    });
    // Final check: no marker tokens remain anywhere in the state.
    expect(JSON.stringify(desiredState)).not.toMatch(/__ASSIGNEE_/);
  });

  // A8 (2026-04-08): The scheduled-lambda compound pattern emits
  // Events::Rule desiredState with Targets as an array of OBJECTS,
  // where each object has an Arn field set to markerGetAtt(LAMBDA_FN, "Arn").
  // walk() must recurse through both the array layer AND the inner
  // object layer to find the nested marker. This test locks in the
  // nested-in-array-of-objects behavior so a future refactor that
  // replaces walk()'s recursion can't silently break scheduled-lambda.
  it("resolves markerGetAtt tokens nested inside an array of objects (Events::Rule Targets)", async () => {
    const desiredState: Record<string, unknown> = {
      ScheduleExpression: "rate(1 hour)",
      State: "ENABLED",
      Targets: [
        {
          Id: "lambda-target",
          Arn: markerGetAtt("lambda-fn", "Arn"),
        },
      ],
    };

    await resolveCompoundMarkers(desiredState, {
      completedResources: [
        {
          resourceId: "lambda-fn",
          resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
          resourceArn: "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      region: "us-east-1",
      currentResourceId: "schedule-rule",
      azLookup: async () => realUsEast1Azs,
    });

    expect(desiredState).toEqual({
      ScheduleExpression: "rate(1 hour)",
      State: "ENABLED",
      Targets: [
        {
          Id: "lambda-target",
          Arn: "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
        },
      ],
    });
    expect(JSON.stringify(desiredState)).not.toMatch(/__ASSIGNEE_/);
  });
});

// ── stripPlaceholderArns (bug-cw-alarm-placeholder-arn) ─────────────────────

describe("stripPlaceholderArns", () => {
  it("removes all placeholder ARNs from AlarmActions and deletes the field", () => {
    const ds: Record<string, unknown> = {
      AlarmName: "cpu-alarm",
      AlarmActions: [
        "arn:aws:sns:us-east-1:123456789012:my-topic",
        "arn:aws:sns:us-east-1:111122223333:other-topic",
      ],
      MetricName: "CPUUtilization",
    };
    stripPlaceholderArns(ds);
    expect(ds["AlarmActions"]).toBeUndefined();
    expect(ds["AlarmName"]).toBe("cpu-alarm");
    expect(ds["MetricName"]).toBe("CPUUtilization");
  });

  it("keeps real ARNs and removes only placeholders from mixed arrays", () => {
    const ds: Record<string, unknown> = {
      AlarmActions: [
        "arn:aws:sns:us-east-1:123456789012:placeholder-topic",
        "arn:aws:sns:us-east-1:210987654321:real-topic",
      ],
    };
    stripPlaceholderArns(ds);
    expect(ds["AlarmActions"]).toEqual([
      "arn:aws:sns:us-east-1:210987654321:real-topic",
    ]);
  });

  it("does not affect non-ARN array fields", () => {
    const ds: Record<string, unknown> = {
      Tags: [
        { Key: "Name", Value: "test" },
        { Key: "Env", Value: "prod" },
      ],
      SecurityGroupIds: ["sg-12345678", "sg-abcdef01"],
    };
    stripPlaceholderArns(ds);
    expect(ds["Tags"]).toHaveLength(2);
    expect(ds["SecurityGroupIds"]).toEqual(["sg-12345678", "sg-abcdef01"]);
  });

  it("strips scalar ARN fields recursively (Epic 92 C-01/C-02)", () => {
    // Epic 92 Wave 1 (e92.1.c) extended stripPlaceholderArns to walk
    // scalar string fields as well as top-level arrays. This closes
    // the RDS Postgres first-attempt failure where LLM-emitted
    // `PerformanceInsightsKMSKeyId: arn:aws:kms:...:key/xxx-…` slipped
    // past the pre-Epic-92 array-only walker and hard-failed preflight.
    //
    // Prior behaviour (pre-Epic 92): scalar placeholders survived the
    // stripper and relied on preflight-guard as the sole backstop —
    // but that backstop emits a hard error, surfacing the LLM's
    // hallucination as an operator-facing failure. The new stripper
    // silently drops LLM emissions first; the guard catches only the
    // user-supplied residue that survives (far narrower surface).
    const ds: Record<string, unknown> = {
      Role: "arn:aws:iam::123456789012:role/my-role",
      AlarmName: "cpu-alarm",
    };
    stripPlaceholderArns(ds);
    expect(ds["Role"]).toBeUndefined();
    // Non-ARN fields are preserved unchanged.
    expect(ds["AlarmName"]).toBe("cpu-alarm");
  });

  it("handles OKActions and InsufficientDataActions the same way", () => {
    const ds: Record<string, unknown> = {
      OKActions: ["arn:aws:sns:us-east-1:123456789012:ok-topic"],
      InsufficientDataActions: [
        "arn:aws:sns:us-east-1:444455556666:insuffdata-topic",
      ],
    };
    stripPlaceholderArns(ds);
    expect(ds["OKActions"]).toBeUndefined();
    expect(ds["InsufficientDataActions"]).toBeUndefined();
  });

  it("handles GovCloud partition ARNs", () => {
    const ds: Record<string, unknown> = {
      AlarmActions: ["arn:aws-us-gov:sns:us-gov-west-1:123456789012:topic"],
    };
    stripPlaceholderArns(ds);
    expect(ds["AlarmActions"]).toBeUndefined();
  });

  it("preserves arrays with all real ARNs unchanged", () => {
    const ds: Record<string, unknown> = {
      AlarmActions: [
        "arn:aws:sns:us-east-1:210987654321:real-topic",
        "arn:aws:sns:us-east-1:109876543210:other-real-topic",
      ],
    };
    stripPlaceholderArns(ds);
    expect(ds["AlarmActions"]).toEqual([
      "arn:aws:sns:us-east-1:210987654321:real-topic",
      "arn:aws:sns:us-east-1:109876543210:other-real-topic",
    ]);
  });
});

// Wave 15: tests for the placeholder-strip heuristic introduced to fix
// the Subnet CidrBlock drop bug. Before Wave 15, collectPluginPlaceholders
// returned every plugin placeholder verbatim, and stripEmpty dropped any
// LLM-supplied value matching one. The Subnet plugin's CidrBlock
// placeholder is "10.0.1.0/24" — a valid CIDR — so users whose actual
// subnet CIDR happened to be 10.0.1.0/24 had it silently dropped from
// the desiredState. Wave 15 narrowed the strip set to OBVIOUSLY-template
// placeholders (containing markers like "my-", "...", "12345").
describe("isTemplatePlaceholder (Wave 15)", () => {
  it("identifies obviously-template values via canonical markers", () => {
    expect(isTemplatePlaceholder("my-bucket")).toBe(true);
    expect(isTemplatePlaceholder("my-function")).toBe(true);
    expect(isTemplatePlaceholder("your-app")).toBe(true);
    expect(isTemplatePlaceholder("arn:aws:kms:...")).toBe(true);
    expect(
      isTemplatePlaceholder("arn:aws:iam::123456789012:role/my-role"),
    ).toBe(true);
    expect(isTemplatePlaceholder("ami-0abcdef1234567890")).toBe(true);
    expect(isTemplatePlaceholder("subnet-0abc1234")).toBe(true);
    expect(
      isTemplatePlaceholder("my-bucket (leave blank for auto-generated)"),
    ).toBe(true);
    expect(isTemplatePlaceholder("KEY1=value1,KEY2=value2")).toBe(true);
    expect(
      isTemplatePlaceholder("Brief description of what this function does"),
    ).toBe(true);
    expect(isTemplatePlaceholder("https://example.com")).toBe(true);
  });

  it("does NOT classify valid-shaped real values as templates", () => {
    // CIDRs — the Wave 14/15 anomaly that started this whole investigation
    expect(isTemplatePlaceholder("10.0.1.0/24")).toBe(false);
    expect(isTemplatePlaceholder("10.0.0.0/16")).toBe(false);
    expect(isTemplatePlaceholder("172.16.0.0/12")).toBe(false);
    // Valid-shaped lambda handler
    expect(isTemplatePlaceholder("index.handler")).toBe(false);
    // Numeric values — could be a real timeout / port / TTL
    expect(isTemplatePlaceholder("30")).toBe(false);
    expect(isTemplatePlaceholder("365")).toBe(false);
    expect(isTemplatePlaceholder("-1")).toBe(false);
    // Real-looking SSM parameter name
    expect(isTemplatePlaceholder("/prod/config/db-host")).toBe(false);
    // Real-looking tag string
    expect(isTemplatePlaceholder("env:production, team:backend")).toBe(false);
  });

  it("is case-insensitive on marker matching", () => {
    expect(isTemplatePlaceholder("MY-bucket")).toBe(true);
    expect(isTemplatePlaceholder("YOUR-app")).toBe(true);
    expect(isTemplatePlaceholder("My-Function")).toBe(true);
    expect(isTemplatePlaceholder("Example.com")).toBe(true);
  });
});

describe("collectPluginPlaceholders (Wave 15)", () => {
  it("returns the Subnet plugin's template placeholders but NOT the realistic CIDR", () => {
    const placeholders = collectPluginPlaceholders(RESOURCE_TYPES.EC2_SUBNET);
    // The CidrBlock placeholder "10.0.1.0/24" must NOT be in the strip
    // set — that's the whole point of Wave 15.
    expect(placeholders.has("10.0.1.0/24")).toBe(false);
    // The Tags placeholder "env:production, tier:public" is also NOT a
    // template (no marker matches) — it's a realistic example. Excluded.
    expect(placeholders.has("env:production, tier:public")).toBe(false);
  });

  it("returns the S3 plugin's obviously-template placeholders", () => {
    const placeholders = collectPluginPlaceholders(RESOURCE_TYPES.S3_BUCKET);
    // The S3 BucketName placeholder is "my-bucket (leave blank for
    // auto-generated)" — both the full string and its prefix "my-bucket"
    // get added to the strip set.
    expect(placeholders.has("my-bucket (leave blank for auto-generated)")).toBe(
      true,
    );
    expect(placeholders.has("my-bucket")).toBe(true);
  });

  it("returns the Lambda plugin's template ARN placeholder", () => {
    const placeholders = collectPluginPlaceholders(
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    // The Lambda Role placeholder is
    // "arn:aws:iam::<your-12-digit-account-id>:role/my-role" — contains
    // both the angle-bracketed placeholder marker AND "my-" → template.
    expect(
      placeholders.has("arn:aws:iam::<your-12-digit-account-id>:role/my-role"),
    ).toBe(true);
  });

  it("returns an empty set for unknown resource types", () => {
    const placeholders = collectPluginPlaceholders("AWS::NotAReal::Type");
    expect(placeholders.size).toBe(0);
  });
});
