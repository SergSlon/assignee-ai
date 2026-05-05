import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MissingAssigneeCredentialsError,
  requireAssigneeCredentials,
} from "../../config/aws-credentials.js";
import {
  ExecutionStatus,
  EIP_AUTO_ALLOCATE,
  ResourceDefault,
  CfnKey,
  RESOURCE_TYPES,
} from "../../index.js";
import {
  resourceProvisionerNode,
  sanitizeKeyName,
  formatErrorForLog,
} from "./resource-provisioner.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "../../ports/provisioning-port.js";

// ── EC2 SDK mock for EIP allocation tests ─────────────────────────────────
const { mockEc2Send } = vi.hoisted(() => ({
  mockEc2Send: vi.fn(),
}));

// NOTE: Plain class/function definitions survive vitest's mockReset:true
// (which would otherwise wipe vi.fn implementations between tests).
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = vi.fn();
  }
  function AllocateAddressCommand(input: unknown) {
    return { _type: "AllocateAddressCommand", input };
  }
  function DescribeAddressesCommand(input: unknown) {
    return { _type: "DescribeAddressesCommand", input };
  }
  function CreateTagsCommand(input: unknown) {
    return { _type: "CreateTagsCommand", input };
  }
  function ReleaseAddressCommand(input: unknown) {
    return { _type: "ReleaseAddressCommand", input };
  }
  function DescribeKeyPairsCommand(input: unknown) {
    return { _type: "DescribeKeyPairsCommand", input };
  }
  function CreateKeyPairCommand(input: unknown) {
    return { _type: "CreateKeyPairCommand", input };
  }
  function DeleteKeyPairCommand(input: unknown) {
    return { _type: "DeleteKeyPairCommand", input };
  }
  return {
    EC2Client,
    AllocateAddressCommand,
    DescribeAddressesCommand,
    CreateTagsCommand,
    ReleaseAddressCommand,
    DescribeKeyPairsCommand,
    CreateKeyPairCommand,
    DeleteKeyPairCommand,
  };
});

// ── IAM mock for SSH-bundle IAM instance-profile pre-hook ────────────────────
// The SSH-IAM pre-hook (Story SSH-Bundle-i) fires whenever userIntent matches
// /\bssh\b/i AND no IamInstanceProfile is supplied. The tests below that
// trigger that path expect the EC2 CCAPI create to PROCEED — so the IAM SDK
// must resolve every call to a success $metadata response. AccessDenied or
// network failure here would short-circuit the pre-hook to FAILED before
// CCAPI even runs.
const { mockIamSend } = vi.hoisted(() => ({ mockIamSend: vi.fn() }));
vi.mock("@aws-sdk/client-iam", () => {
  class IAMClient {
    send = mockIamSend;
    destroy = vi.fn();
  }
  function CreateRoleCommand(input: unknown) {
    return { _type: "CreateRoleCommand", input };
  }
  function AttachRolePolicyCommand(input: unknown) {
    return { _type: "AttachRolePolicyCommand", input };
  }
  function CreateInstanceProfileCommand(input: unknown) {
    return { _type: "CreateInstanceProfileCommand", input };
  }
  function AddRoleToInstanceProfileCommand(input: unknown) {
    return { _type: "AddRoleToInstanceProfileCommand", input };
  }
  // BLOCKER #2 fix (Story i SSH-IAM compound review): ssh-iam.ts now
  // tags the auto-created instance profile via TagInstanceProfileCommand
  // (CreateInstanceProfile does NOT accept inline Tags). Without this
  // entry the dynamic destructure in ssh-iam.ts:170 yields `undefined`
  // and `new TagInstanceProfileCommand(...)` throws `not a constructor`,
  // failing the SSH pre-hook → every SSH-bundle test sees FAILED instead
  // of IN_PROGRESS.
  function TagInstanceProfileCommand(input: unknown) {
    return { _type: "TagInstanceProfileCommand", input };
  }
  function RemoveRoleFromInstanceProfileCommand(input: unknown) {
    return { _type: "RemoveRoleFromInstanceProfileCommand", input };
  }
  function DeleteInstanceProfileCommand(input: unknown) {
    return { _type: "DeleteInstanceProfileCommand", input };
  }
  function DetachRolePolicyCommand(input: unknown) {
    return { _type: "DetachRolePolicyCommand", input };
  }
  function DeleteRoleCommand(input: unknown) {
    return { _type: "DeleteRoleCommand", input };
  }
  return {
    IAMClient,
    CreateRoleCommand,
    AttachRolePolicyCommand,
    CreateInstanceProfileCommand,
    AddRoleToInstanceProfileCommand,
    TagInstanceProfileCommand,
    RemoveRoleFromInstanceProfileCommand,
    DeleteInstanceProfileCommand,
    DetachRolePolicyCommand,
    DeleteRoleCommand,
  };
});

// ── FS mocks for SSH key pair creation ───────────────────────────────────────
const { mockMkdirSync, mockWriteFileSync, mockChmodSync } = vi.hoisted(() => ({
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockChmodSync: vi.fn(),
}));

// importOriginal preserves `constants` (F018 O_NOFOLLOW import dependency).
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    chmodSync: mockChmodSync,
  };
});

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return actual;
});

// ── Mock provisioning port ──────────────────────────────────────────────────

function createMockProvisioner(): ProvisioningPort & {
  getResource: ReturnType<typeof vi.fn>;
  createResource: ReturnType<typeof vi.fn>;
  getRequestStatus: ReturnType<typeof vi.fn>;
  deleteResource: ReturnType<typeof vi.fn>;
  updateResource: ReturnType<typeof vi.fn>;
} {
  return {
    getResource: vi.fn(),
    createResource: vi.fn(),
    getRequestStatus: vi.fn(),
    deleteResource: vi.fn(),
    updateResource: vi.fn(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let mockProvisioner: ReturnType<typeof createMockProvisioner>;

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an S3 bucket named poc-smoke-test",
    runId: "run-prov-test-001",
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "apply",
    resourceType: "AWS::S3::Bucket",
    resourceSchema: undefined,
    desiredState: { BucketName: "poc-smoke-test" },
    estimatedMonthlyCost: "$0.0230/GB-month",
    requestToken: undefined,
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<typeof resourceProvisionerNode>[0];
}

// Snapshot env so per-test credential mutations don't leak between cases
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockProvisioner = createMockProvisioner();
  // resource-provisioner now uses requireAssigneeCredentials("operator") for
  // every EC2Client it constructs (EIP allocation, EIP release, SSH key
  // create, SSH key delete). Provide realistic-shaped operator credentials
  // so the constructor succeeds and the mocked send() receives the call.
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  // SSH-bundle IAM pre-hook (Story SSH-Bundle-i): default to a plain success
  // response so existing tests that include "SSH" in userIntent continue to
  // proceed past the pre-hook into the CCAPI path. Tests that want to assert
  // IAM-specific behaviour can mockReset / mockResolvedValueOnce.
  mockIamSend.mockResolvedValue({
    $metadata: { httpStatusCode: 200, requestId: "iam-test-default" },
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resourceProvisionerNode", () => {
  describe("pre-flight guards", () => {
    it("returns empty when executionStatus is CANCELLED", async () => {
      const result = await resourceProvisionerNode(
        makeState({ executionStatus: ExecutionStatus.CANCELLED }),
        mockProvisioner,
      );
      expect(result).toEqual({});
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("fails when desiredState is missing", async () => {
      const result = await resourceProvisionerNode(
        makeState({ desiredState: undefined }),
        mockProvisioner,
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/desiredState is missing/);
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("fails when resourceType is empty string (Story 9.1: isResourceType guard)", async () => {
      const result = await resourceProvisionerNode(
        makeState({ resourceType: "" }),
        mockProvisioner,
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /unsupported or missing resourceType/,
      );
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("fails when resourceType is not a known ResourceType (Story 9.1: isResourceType guard)", async () => {
      const result = await resourceProvisionerNode(
        makeState({ resourceType: "AWS::Fake::Resource" }),
        mockProvisioner,
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /unsupported or missing resourceType/,
      );
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });
  });

  describe("state guard (FR-15 Read-Before-Write)", () => {
    it("aborts with Stale Plan error when getResource succeeds (resource exists)", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([null, {}]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "existing-role",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/already exists/);
      expect(result.errorMessage).toMatch(/existing-role/);
      expect(mockProvisioner.getResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        "existing-role",
      );
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
    });

    it("skips state guard for S3 buckets (globally unique names cause false positives)", async () => {
      // S3 GetResource can return success for buckets in OTHER accounts,
      // so the state guard is skipped entirely for S3.
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "s3-skip-guard-token" },
      ]);

      const result = await resourceProvisionerNode(
        makeState(),
        mockProvisioner,
      );

      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::S3::Bucket",
        expect.stringContaining('"BucketName":"poc-smoke-test"'),
        expect.any(String),
      );
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    });

    it("proceeds when getResource returns NOT_FOUND (resource not found — safe to create)", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "0ff011d6-654f-4110-8a37-9754bd6aad59" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "new-role",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("0ff011d6-654f-4110-8a37-9754bd6aad59");
    });

    it("proceeds with creation when getResource throws a non-NOT_FOUND error (Story E2E.4)", async () => {
      // State guard now treats ALL non-NOT_FOUND errors as "can't verify, proceed"
      // This handles: UNKNOWN, invalid identifiers (SecretsManager, Route), etc.
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.UNKNOWN, message: "Invalid identifier" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "token-unknown-skip" },
      ]);

      await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "role-unknown-err",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
          },
        }),
        mockProvisioner,
      );

      // Should proceed to create, not fail at state guard
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        expect.stringContaining('"RoleName":"role-unknown-err"'),
        expect.any(String),
      );
    });

    it("proceeds with creation when getResource returns ACCESS_DENIED", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.ACCESS_DENIED, message: "Access denied" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "token-access-denied" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "role-access-denied",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        expect.stringContaining('"RoleName":"role-access-denied"'),
        expect.any(String),
      );
    });

    it("skips state guard when identifier cannot be derived (no BucketName)", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "token-no-id" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({ desiredState: { Tags: [] } }),
        mockProvisioner,
      );

      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
      // System tags (managed-by, assignee-run-id, environment) are
      // merged into the user-provided Tags array by the provisioner.
      // The starting Tags=[] is empty, so the merged result contains
      // exactly the three system tags.
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::S3::Bucket",
        expect.stringContaining('"Key":"managed-by","Value":"assignee-ai"'),
        expect.any(String),
      );
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    });
  });

  describe("happy path — CloudControl create workflow", () => {
    it("calls getResource then createResource and returns IN_PROGRESS with requestToken", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "0ff011d6-654f-4110-8a37-9754bd6aad59" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "poc-role-test",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("0ff011d6-654f-4110-8a37-9754bd6aad59");
      // Wave 16: strengthened — startedAt is a Date.now() millis value
      // (per packages/core/src/schema/graph-state.ts:75 — number, not
      // ISO string). Assert it's a positive integer within ±5 minutes
      // of "now". Catches regressions where startedAt is set to NaN,
      // 0, an out-of-band ISO string, or an unrelated value.
      expect(typeof result.startedAt).toBe("number");
      expect(result.startedAt!).toBeGreaterThan(0);
      expect(Math.abs(Date.now() - result.startedAt!)).toBeLessThan(
        5 * 60 * 1000,
      );

      expect(mockProvisioner.getResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        "poc-role-test",
      );
      // H11: ClientToken now carries a per-attempt random suffix so retries
      // of the same runId produce different tokens. Assert the runId prefix
      // instead of exact equality.
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        expect.stringContaining("poc-role-test"),
        expect.stringMatching(/^run-prov-test-001-[0-9a-f]{12}$/),
      );
    });

    it("injects mandatory tags into createResource desiredState", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "tag-test-token" },
      ]);

      await resourceProvisionerNode(makeState(), mockProvisioner);

      const desiredStateJson = mockProvisioner.createResource.mock
        .calls[0]![1] as string;
      const desiredState = JSON.parse(desiredStateJson) as Record<
        string,
        unknown
      >;

      // NFR-14: mandatory traceability tags must be injected
      expect(desiredState).toHaveProperty("Tags");
      expect(desiredState["Tags"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Key: "assignee-run-id",
            Value: "run-prov-test-001",
          }),
          expect.objectContaining({ Key: "managed-by", Value: "assignee-ai" }),
        ]),
      );
    });

    it("works for AWS::SSM::Parameter with Name as identifier", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "ssm-req-token-abc" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::SSM::Parameter",
          desiredState: {
            Name: "/app/config/env",
            Value: "production",
            Type: "String",
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("ssm-req-token-abc");

      // NFR-14: SSM Parameter uses flat map Tags, not [{Key, Value}] array
      const desiredStateJson = mockProvisioner.createResource.mock
        .calls[0]![1] as string;
      const desiredState = JSON.parse(desiredStateJson) as Record<
        string,
        unknown
      >;
      expect(Array.isArray(desiredState["Tags"])).toBe(false);
      expect(
        (desiredState["Tags"] as Record<string, string>)["managed-by"],
      ).toBe("assignee-ai");
    });

    it("works for AWS::IAM::Role with RoleName as identifier", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "iam-req-token-xyz" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "poc-lambda-role",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("iam-req-token-xyz");
    });
  });

  describe("missing RequestToken guard", () => {
    it("fails when createResource returns error with no RequestToken (no ProgressEvent)", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.UNKNOWN,
          message: "CreateResource returned no RequestToken",
        },
        null,
      ]);

      const result = await resourceProvisionerNode(
        makeState(),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/no RequestToken/);
    });

    it("fails when createResource returns error with empty ProgressEvent", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.UNKNOWN,
          message: "CreateResource returned no RequestToken",
        },
        null,
      ]);

      const result = await resourceProvisionerNode(
        makeState(),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/no RequestToken/);
    });
  });

  describe("error handling — typed provisioning errors (Story 9.2: AC #3)", () => {
    it("maps ALREADY_EXISTS to FAILED with 'already exists' message", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.ALREADY_EXISTS,
          message: "already exists",
        },
        null,
      ]);

      const result = await resourceProvisionerNode(
        makeState(),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /already taken globally|already exists/i,
      );
      expect(result.errorMessage).toMatch(/CloudControl provisioning failed/);
    });

    it("maps THROTTLED to FAILED with 'throttled' message", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.THROTTLED, message: "Rate exceeded" },
        null,
      ]);

      const result = await resourceProvisionerNode(
        makeState(),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/throttled/i);
    });

    it("falls back to generic message for unknown errors", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.UNKNOWN,
          message: "Unable to locate credentials.",
        },
        null,
      ]);

      const result = await resourceProvisionerNode(
        makeState(),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/CloudControl provisioning failed/);
      expect(result.errorMessage).toMatch(/Unable to locate credentials/);
    });
  });

  // ── Inline CCAPI redirect classifier (Story 7.7; inlined Story 50-7) ──────
  // A6 (2026-04-08): Lambda EventSourceMapping was migrated to CCAPI.
  // A10 (2026-04-09): SNS Subscription promoted to first-class.
  // Story 50-7 (2026-04-16): the SDKFallbackDispatcher class was deleted;
  // the redirect classifier now lives inline in resource-provisioner.ts.
  //
  // These tests exercise the inline classifier — the two remaining
  // redirect-only types (Lambda::Permission, ElastiCache::ReplicationGroup)
  // short-circuit with a friendly "use X instead" message, and every
  // other type falls through to the standard CCAPI path.

  describe("inline CCAPI redirect classifier", () => {
    it("does NOT dispatch Lambda EventSourceMapping via SDK fallback (A6 — migrated to CCAPI)", async () => {
      // ESM has no plugin / pattern / intent path, so it is deliberately
      // absent from SUPPORTED_TYPES_ARRAY; the provisioner's state guard
      // rejects any ESM create request as an unsupported type. The
      // destroy-by-ARN path (covered in destroy-service.test.ts) remains
      // the only reachable ESM code path.
      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::Lambda::EventSourceMapping",
          desiredState: {
            EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:queue",
            FunctionName: "my-function",
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /unsupported or missing resourceType/,
      );
      // Neither the CCAPI path should have run.
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("routes SNS Subscription through the standard CCAPI path (A10 — promoted to first-class)", async () => {
      // A10 (2026-04-09): SNS::Subscription was promoted out of
      // CCAPI_FALLBACK_TYPES. It flows through the standard
      // CloudControl CreateResource path, same as every other
      // first-class type.
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "sns-sub-token" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::SNS::Subscription",
          desiredState: {
            TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
            Protocol: "sqs",
            Endpoint: "arn:aws:sqs:us-east-1:123456789012:queue",
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("sns-sub-token");
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::SNS::Subscription",
        expect.stringContaining(
          '"TopicArn":"arn:aws:sns:us-east-1:123456789012:my-topic"',
        ),
        expect.any(String),
      );
    });

    it("returns FAILED with redirect message for Lambda::Permission", async () => {
      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::Lambda::Permission",
          desiredState: {
            Action: "lambda:InvokeFunction",
            FunctionName: "my-function",
            Principal: "sns.amazonaws.com",
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /AWS::Lambda::Permission is not supported by CCAPI/,
      );
      expect(result.errorMessage).toMatch(/PermissionPolicy/);
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("returns FAILED with redirect message for ElastiCache::ReplicationGroup", async () => {
      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::ElastiCache::ReplicationGroup",
          desiredState: {
            ReplicationGroupDescription: "test",
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /ElastiCache ReplicationGroup is not supported/,
      );
      expect(result.errorMessage).toMatch(/ServerlessCache/);
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("falls through to CloudControl path for standard types", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "standard-token" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "fallback-test-role",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("standard-token");
      expect(mockProvisioner.getResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        "fallback-test-role",
      );
    });

    it("surfaces CCAPI NOT_FOUND on SNS Subscription TopicArn mistakes (A10 path)", async () => {
      // A10 follow-up: when the referenced topic does not exist,
      // CCAPI CreateResource surfaces a validation error through
      // the standard provisioner path.
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.NOT_FOUND,
          message:
            "Topic arn:aws:sns:us-east-1:123456789012:missing-topic not found",
        },
        null,
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::SNS::Subscription",
          desiredState: {
            TopicArn: "arn:aws:sns:us-east-1:123456789012:missing-topic",
            Protocol: "sqs",
            Endpoint: "arn:aws:sqs:us-east-1:123456789012:queue",
          },
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    });
  });

  // ── provisionable=false skip (Epic 37) ──────────────────────────────────

  describe("provisionable=false resources", () => {
    it("skips provisioning and returns SUCCESS for non-provisionable resources", async () => {
      const state = makeState({
        resourceType: "AWS::CloudFront::Distribution",
        desiredState: undefined, // No desired state for companion resources
        resourceQueue: [
          {
            resourceType: "AWS::S3::Bucket",
            resourceId: "bucket",
            displayName: "Bucket",
          },
          {
            resourceType: "AWS::CloudFront::Distribution",
            resourceId: "cdn",
            displayName: "CDN",
            provisionable: false,
          },
        ],
        currentResourceIndex: 1, // Points to the non-provisionable resource
      });

      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
      expect(result.resourceArn).toBeUndefined();
      // CloudControl should NOT have been called
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("does NOT skip provisionable=true resources (default)", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "tok-123" },
      ]);

      const state = makeState({
        resourceQueue: [
          {
            resourceType: "AWS::S3::Bucket",
            resourceId: "bucket",
            displayName: "Bucket",
          },
        ],
        currentResourceIndex: 0,
      });

      await resourceProvisionerNode(state, mockProvisioner);

      // CloudControl SHOULD have been called
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::S3::Bucket",
        expect.stringContaining('"BucketName":"poc-smoke-test"'),
        expect.any(String),
      );
    });
  });

  // ── P0: EIP leak prevention for NatGateway (Story 42.1) ─────────────────
  describe("EIP allocation for NatGateway — leak prevention", () => {
    function makeNatGwState(overrides: Record<string, unknown> = {}) {
      return makeState({
        resourceType: "AWS::EC2::NatGateway",
        runId: "run-natgw-eip-001",
        desiredState: {
          SubnetId: "subnet-abc123",
          AllocationId: EIP_AUTO_ALLOCATE,
        },
        ...overrides,
      });
    }

    beforeEach(() => {
      mockEc2Send.mockReset();
    });

    it("allocates a new EIP and tags it with runId on first attempt", async () => {
      // DescribeAddresses returns no existing EIPs for this runId
      mockEc2Send
        .mockResolvedValueOnce({ Addresses: [] }) // DescribeAddressesCommand
        .mockResolvedValueOnce({ AllocationId: "eipalloc-new-001" }) // AllocateAddressCommand
        .mockResolvedValueOnce({}); // CreateTagsCommand

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "natgw-token-001" },
      ]);

      const state = makeNatGwState();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);

      // Verify EIP was allocated
      expect(mockEc2Send).toHaveBeenCalledTimes(3); // Describe + Allocate + CreateTags
      expect(result.desiredState!["AllocationId"]).toBe("eipalloc-new-001");

      // Verify CreateTags was called to tag the EIP for retry tracking
      const createTagsCall = mockEc2Send.mock.calls[2]![0] as {
        _type: string;
        input: { Resources: string[]; Tags: { Key: string; Value: string }[] };
      };
      expect(createTagsCall._type).toBe("CreateTagsCommand");
      expect(createTagsCall.input.Resources).toEqual(["eipalloc-new-001"]);
      // Wave 19 Bug #6: EIPs must carry BOTH the runId tag (used for retry
      // discovery via DescribeAddresses) AND the standard managed-by tag
      // so the Resource Groups Tagging API returns them to
      // `fetchManagedResources` / `assignee list` / `bulk-destroy`. Before
      // this fix, EIPs were only tagged with assignee:runId, so they were
      // invisible to the destroy path and leaked at ~$3.60/month each.
      // The 2026-04-08 live smoke recovered 6 EIPs leaked from prior runs.
      expect(createTagsCall.input.Tags).toEqual([
        { Key: "assignee:runId", Value: "run-natgw-eip-001" },
        { Key: "managed-by", Value: "assignee-ai" },
      ]);
    });

    it("reuses existing EIP on retry instead of allocating a new one (P0 leak fix)", async () => {
      // DescribeAddresses returns an EIP already tagged with this runId
      mockEc2Send.mockResolvedValueOnce({
        Addresses: [{ AllocationId: "eipalloc-existing-999" }],
      }); // DescribeAddressesCommand

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "natgw-retry-token" },
      ]);

      const state = makeNatGwState();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);

      // Should NOT have called AllocateAddress — only DescribeAddresses
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
      expect(result.desiredState!["AllocationId"]).toBe(
        "eipalloc-existing-999",
      );

      // Verify DescribeAddresses filter used the runId tag
      const describeCall = mockEc2Send.mock.calls[0]![0] as {
        _type: string;
        input: {
          Filters: { Name: string; Values: string[] }[];
        };
      };
      expect(describeCall._type).toBe("DescribeAddressesCommand");
      expect(describeCall.input.Filters).toEqual(
        expect.arrayContaining([
          { Name: "tag:assignee:runId", Values: ["run-natgw-eip-001"] },
        ]),
      );
    });

    it("falls back to allocating new EIP if DescribeAddresses fails", async () => {
      // DescribeAddresses throws an error
      mockEc2Send
        .mockRejectedValueOnce(new Error("Access denied")) // DescribeAddressesCommand fails
        .mockResolvedValueOnce({ AllocationId: "eipalloc-fallback-001" }) // AllocateAddressCommand
        .mockResolvedValueOnce({}); // CreateTagsCommand

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "natgw-fallback-token" },
      ]);

      const state = makeNatGwState();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.desiredState!["AllocationId"]).toBe(
        "eipalloc-fallback-001",
      );
    });

    it("releases EIP on CloudControl failure (best-effort cleanup)", async () => {
      // First attempt: allocate EIP successfully
      mockEc2Send
        .mockResolvedValueOnce({ Addresses: [] }) // DescribeAddressesCommand
        .mockResolvedValueOnce({ AllocationId: "eipalloc-cleanup-001" }) // AllocateAddressCommand
        .mockResolvedValueOnce({}) // CreateTagsCommand
        .mockResolvedValueOnce({}); // ReleaseAddressCommand

      // CloudControl fails
      mockProvisioner.createResource.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.UNKNOWN,
          message: "NAT Gateway creation failed",
        },
        null,
      ]);

      const state = makeNatGwState();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);

      // Verify ReleaseAddress was called for cleanup
      expect(mockEc2Send).toHaveBeenCalledTimes(4);
      const releaseCall = mockEc2Send.mock.calls[3]![0] as {
        _type: string;
        input: { AllocationId: string };
      };
      expect(releaseCall._type).toBe("ReleaseAddressCommand");
      expect(releaseCall.input.AllocationId).toBe("eipalloc-cleanup-001");
    });
  });

  // ── SSH key pair creation for EC2 ────────────────────────────────────────────

  describe("SSH key pair creation", () => {
    function makeEc2State(overrides: Record<string, unknown> = {}) {
      return makeState({
        resourceType: RESOURCE_TYPES.EC2_INSTANCE,
        userIntent: "Create an EC2 instance I can SSH into",
        desiredState: {
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          KeyName: ResourceDefault.SSH_KEY_PLACEHOLDER,
          MetadataOptions: { HttpTokens: "required" },
        },
        ...overrides,
      });
    }

    it("creates key pair and saves .pem when placeholder KeyName is set and key does not exist", async () => {
      // DescribeKeyPairs throws "not found", CreateKeyPair succeeds
      const notFoundErr = new Error("Key pair not found");
      (notFoundErr as { name: string }).name = "InvalidKeyPair.NotFound";
      mockEc2Send
        .mockRejectedValueOnce(notFoundErr) // DescribeKeyPairsCommand
        .mockResolvedValueOnce({
          KeyMaterial:
            "-----BEGIN RSA PRIVATE KEY-----\nMOCK_KEY\n-----END RSA PRIVATE KEY-----",
        }); // CreateKeyPairCommand

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "ec2-ssh-token" },
      ]);

      const state = makeEc2State();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);

      // Verify key was written
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("assignee-ssh-key.pem"),
        expect.stringContaining("BEGIN RSA PRIVATE KEY"),
        { mode: 0o400 },
      );
      // M-R7: keys directory must be created with mode 0o700 — never the
      // default 0o755 which would leak the listing of provisioned key
      // names to other local users via world-readable directory bits.
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("keys"),
        { recursive: true, mode: 0o700 },
      );
      // Belt-and-suspenders chmod for pre-existing directories.
      expect(mockChmodSync).toHaveBeenCalledWith(
        expect.stringContaining("keys"),
        0o700,
      );
    });

    it("skips key creation when key pair already exists in AWS", async () => {
      // DescribeKeyPairs succeeds — key exists
      mockEc2Send.mockResolvedValueOnce({
        KeyPairs: [{ KeyName: ResourceDefault.SSH_KEY_PLACEHOLDER }],
      });

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "ec2-existing-key-token" },
      ]);

      const state = makeEc2State();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      // Only 1 call (DescribeKeyPairs), no CreateKeyPair
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("does NOT trigger key creation for user-supplied KeyName (not placeholder)", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "ec2-user-key-token" },
      ]);

      const state = makeEc2State({
        desiredState: {
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          KeyName: "my-personal-key",
          MetadataOptions: { HttpTokens: "required" },
        },
      });
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      // No EC2 SDK calls for key pair
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it("removes KeyName from desiredState when key creation fails", async () => {
      // DescribeKeyPairs throws "not found", CreateKeyPair also fails
      const notFoundErr = new Error("Key pair not found");
      (notFoundErr as { name: string }).name = "InvalidKeyPair.NotFound";
      mockEc2Send
        .mockRejectedValueOnce(notFoundErr) // DescribeKeyPairsCommand
        .mockRejectedValueOnce(new Error("AccessDenied")); // CreateKeyPairCommand fails

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "ec2-no-key-token" },
      ]);

      const state = makeEc2State();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      // KeyName should be removed so CloudControl doesn't fail
      expect(result.desiredState!["KeyName"]).toBeUndefined();
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    });

    it("FAILS the resource on transient DescribeKeyPairs error — does NOT silently strip KeyName (C2)", async () => {
      // C2: DescribeKeyPairs failing with a non-NotFound error means we
      // cannot confirm whether the key exists. If the key DOES exist in AWS
      // and we silently stripped KeyName, the instance would be provisioned
      // with no keypair and the user would be permanently SSH-locked-out.
      // The correct behavior is to FAIL with a clear error instead.
      const accessDenied = new Error("User not authorized");
      (accessDenied as { name: string }).name = "UnauthorizedOperation";
      mockEc2Send.mockRejectedValueOnce(accessDenied);

      const state = makeEc2State();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      // Must FAIL, not silently strip KeyName
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/SSH key pair verification failed/);
      expect(result.errorMessage).toMatch(/User not authorized/);
      // KeyName must NOT be stripped — surface the original placeholder
      // so a retry can attempt verification again with the same intent.
      expect(result.desiredState!["KeyName"]).toBe(
        ResourceDefault.SSH_KEY_PLACEHOLDER,
      );
      // Should NOT have tried CreateKeyPair — we never got past verify
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
      // CloudControl should NOT have been called — we failed before create
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
    });

    it("throws when KeyMaterial is empty", async () => {
      const notFoundErr = new Error("Key pair not found");
      (notFoundErr as { name: string }).name = "InvalidKeyPair.NotFound";
      mockEc2Send
        .mockRejectedValueOnce(notFoundErr) // DescribeKeyPairsCommand
        .mockResolvedValueOnce({ KeyMaterial: undefined }); // CreateKeyPairCommand — empty!

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "ec2-empty-key-token" },
      ]);

      const state = makeEc2State();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      // Empty KeyMaterial triggers an error — KeyName removed
      expect(result.desiredState!["KeyName"]).toBeUndefined();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    });

    // ── V1 N3 audit (2026-04-06): tracker ordering ─────────────────────
    it("cleans up SSH key pair when mkdirSync throws after CreateKeyPair", async () => {
      // Reproduces the original race: AWS confirms the key was created,
      // then mkdirSync (or any fs op before writeFileSync) throws. The
      // pre-fix code only set sshKeyCreatedName immediately before
      // writeFileSync, so this throw left the tracker undefined and the
      // cleanup hook never deleted the key from AWS — leaking it.
      const notFoundErr = new Error("Key pair not found");
      (notFoundErr as { name: string }).name = "InvalidKeyPair.NotFound";
      mockEc2Send
        .mockRejectedValueOnce(notFoundErr) // DescribeKeyPairsCommand
        .mockResolvedValueOnce({
          KeyMaterial:
            "-----BEGIN RSA PRIVATE KEY-----\nMOCK\n-----END RSA PRIVATE KEY-----",
        }) // CreateKeyPairCommand — succeeds
        .mockResolvedValueOnce({}); // DeleteKeyPairCommand — cleanup must run

      // mkdirSync throws BEFORE writeFileSync runs (e.g. EACCES on
      // ~/.assignee/keys/ when the home directory is read-only).
      mockMkdirSync.mockImplementationOnce(() => {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      });

      // CloudControl shouldn't be called since we'll fail before that, but
      // arm the mock just in case the failure flow tries to invoke it.
      mockProvisioner.createResource.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.UNKNOWN,
          message: "should not be reached",
        },
        null,
      ]);

      const state = makeEc2State();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      // Cleanup MUST have run — DeleteKeyPairCommand was sent for the
      // placeholder key name even though writeFileSync never executed.
      const deleteCalls = mockEc2Send.mock.calls.filter((c) => {
        const cmd = c[0] as { _type?: string };
        return cmd._type === "DeleteKeyPairCommand";
      });
      expect(deleteCalls).toHaveLength(1);
      const deleteCmd = deleteCalls[0]![0] as {
        input: { KeyName: string };
      };
      expect(deleteCmd.input.KeyName).toBe(ResourceDefault.SSH_KEY_PLACEHOLDER);

      // The .pem must NEVER have been written
      expect(mockWriteFileSync).not.toHaveBeenCalled();

      // Provision result should be a failure (the fs error propagated)
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    });

    it("cleans up SSH key pair on provision failure", async () => {
      const notFoundErr = new Error("Key pair not found");
      (notFoundErr as { name: string }).name = "InvalidKeyPair.NotFound";
      mockEc2Send
        .mockRejectedValueOnce(notFoundErr) // DescribeKeyPairsCommand
        .mockResolvedValueOnce({
          KeyMaterial:
            "-----BEGIN RSA PRIVATE KEY-----\nMOCK\n-----END RSA PRIVATE KEY-----",
        }) // CreateKeyPairCommand
        .mockResolvedValueOnce({}); // DeleteKeyPairCommand (cleanup)

      // Provision fails
      mockProvisioner.createResource.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.UNKNOWN,
          message: "EC2 instance creation failed",
        },
        null,
      ]);

      const state = makeEc2State();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);

      // Verify DeleteKeyPair was called for cleanup
      expect(mockEc2Send).toHaveBeenCalledTimes(3);
      const deleteCall = mockEc2Send.mock.calls[2]![0] as {
        _type: string;
        input: { KeyName: string };
      };
      expect(deleteCall._type).toBe("DeleteKeyPairCommand");
      expect(deleteCall.input.KeyName).toBe(
        ResourceDefault.SSH_KEY_PLACEHOLDER,
      );
    });

    it("skips key pair block entirely when KeyName is empty string", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "ec2-no-keyname-token" },
      ]);

      const state = makeEc2State({
        desiredState: {
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          KeyName: "",
          MetadataOptions: { HttpTokens: "required" },
        },
      });
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });
  });

  // ── LangGraph state immutability contract (Item F) ──────────────────────────
  // FIX LANDED 2026-04-26 (MASTER-013) — state.desiredState is now immutable;
  // tests below verify. The orchestrator clones via `safeCloneDesiredState`
  // (resource-provisioner.ts:80) before passing to any helper, and returns
  // the cloned object to the reducer in every code path. The two historical
  // mutation sites — `desiredState[CfnKey.ALLOCATION_ID] = …` in
  // eip-allocator.ts and `delete desiredState[CfnKey.KEY_NAME]` in
  // ssh-keypair.ts — now operate on the local clone, never on
  // `state.desiredState`. Tests below assert (a) input reference identity
  // is preserved, (b) input contents are deep-equal to the pre-call clone,
  // and (c) the returned partial carries a NEW object with the resolved
  // values via the reducer.
  describe("LangGraph state immutability (Item F)", () => {
    it("EIP allocation must NOT mutate the input state.desiredState in place", async () => {
      // DescribeAddresses returns no existing EIPs, then AllocateAddress + CreateTags succeed
      mockEc2Send
        .mockResolvedValueOnce({ Addresses: [] })
        .mockResolvedValueOnce({ AllocationId: "eipalloc-immut-001" })
        .mockResolvedValueOnce({});

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "natgw-immut-token" },
      ]);

      const state = makeState({
        resourceType: "AWS::EC2::NatGateway",
        runId: "run-natgw-immut-001",
        desiredState: {
          SubnetId: "subnet-abc123",
          AllocationId: EIP_AUTO_ALLOCATE,
        },
      });

      // Capture references and a deep clone BEFORE invoking the node
      const originalDesiredStateRef = state.desiredState;
      const originalDesiredStateClone = structuredClone(state.desiredState);

      const result = await resourceProvisionerNode(state, mockProvisioner);

      // Sanity: provisioning succeeded
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);

      // Identity check: the input desiredState reference must be untouched
      expect(state.desiredState).toBe(originalDesiredStateRef);

      // Deep equality: the input desiredState contents must be unchanged —
      // AllocationId must STILL be the placeholder, NOT the resolved id
      expect(state.desiredState).toEqual(originalDesiredStateClone);
      expect(state.desiredState![CfnKey.ALLOCATION_ID]).toBe(EIP_AUTO_ALLOCATE);

      // Once the code fix lands, the node should expose the resolved
      // AllocationId via a returned `desiredState` partial (or equivalent
      // mechanism) — assert it is a NEW object, not the same reference.
      // Wave 16: dropped redundant `toBeDefined()` — the `![CfnKey.X]`
      // chains below already throw on undefined, AND the `not.toBe(ref)`
      // implicitly requires the value to be an object (`not.toBe` on
      // undefined vs reference returns true, so this IS load-bearing).
      const returnedDesired = (
        result as { desiredState?: Record<string, unknown> }
      ).desiredState;
      expect(typeof returnedDesired).toBe("object");
      expect(returnedDesired).not.toBe(originalDesiredStateRef);
      expect(returnedDesired![CfnKey.ALLOCATION_ID]).toBe("eipalloc-immut-001");
    });

    it("SSH key failure path must NOT delete KeyName from input state.desiredState in place", async () => {
      // DescribeKeyPairs returns "not found", CreateKeyPair fails — triggers
      // the `delete state.desiredState[CfnKey.KEY_NAME]` mutation.
      const notFoundErr = new Error("Key pair not found");
      (notFoundErr as { name: string }).name = "InvalidKeyPair.NotFound";
      mockEc2Send
        .mockRejectedValueOnce(notFoundErr)
        .mockRejectedValueOnce(new Error("AccessDenied"));

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "ec2-immut-token" },
      ]);

      const state = makeState({
        resourceType: RESOURCE_TYPES.EC2_INSTANCE,
        userIntent: "Create an EC2 instance I can SSH into",
        desiredState: {
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          KeyName: ResourceDefault.SSH_KEY_PLACEHOLDER,
          MetadataOptions: { HttpTokens: "required" },
        },
      });

      // Capture references BEFORE invoking the node
      const originalDesiredStateRef = state.desiredState;
      const originalDesiredStateClone = structuredClone(state.desiredState);

      const result = await resourceProvisionerNode(state, mockProvisioner);

      // Sanity: provisioning continued past the SSH key failure
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);

      // Identity check: the input desiredState reference must be untouched
      expect(state.desiredState).toBe(originalDesiredStateRef);

      // Deep equality: KeyName must STILL be present on the input — the
      // delete operation must NOT have propagated to the original state.
      expect(state.desiredState).toEqual(originalDesiredStateClone);
      expect(state.desiredState![CfnKey.KEY_NAME]).toBe(
        ResourceDefault.SSH_KEY_PLACEHOLDER,
      );

      // Once the code fix lands, the node should expose the cleaned
      // desiredState (without KeyName) via the returned partial.
      // Wave 16: strengthened — assert returnedDesired is an object.
      const returnedDesired = (
        result as { desiredState?: Record<string, unknown> }
      ).desiredState;
      expect(typeof returnedDesired).toBe("object");
      expect(returnedDesired).not.toBe(originalDesiredStateRef);
      expect(returnedDesired![CfnKey.KEY_NAME]).toBeUndefined();
    });
  });

  // ── Fail-closed credential enforcement ─────────────────────────────────────
  // The provisioner constructs EC2Clients in four places — EIP allocate, EIP
  // release, SSH key create, SSH key delete. Each one uses
  // requireAssigneeCredentials("operator"). When the operator env vars are
  // unset, the constructor must throw MissingAssigneeCredentialsError and the
  // SDK send() must NEVER be called — even if shell AWS_* vars are populated.
  describe("fail-closed when ASSIGNEE_OPERATOR_* env vars are missing", () => {
    beforeEach(() => {
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
      // Belt-and-suspenders: shell AWS_* must NOT be honored
      process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";
    });

    it("NatGateway EIP allocation fails with MissingAssigneeCredentialsError and never calls SDK", async () => {
      mockProvisioner.createResource.mockResolvedValue([
        null,
        { requestToken: "x" },
      ]);

      const state = makeState({
        resourceType: "AWS::EC2::NatGateway",
        runId: "run-natgw-failclosed",
        desiredState: {
          SubnetId: "subnet-abc123",
          AllocationId: EIP_AUTO_ALLOCATE,
        },
      });

      const result = await resourceProvisionerNode(state, mockProvisioner);

      // The EC2Client constructor threw inside the try-block; the outer catch
      // converts it to a FAILED execution. Verify the SDK was never called.
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/EIP allocation failed/);
      expect(result.errorMessage).toMatch(/ASSIGNEE_OPERATOR_ACCESS_KEY_ID/);
      expect(mockEc2Send).not.toHaveBeenCalled();
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
    });

    it("EC2 SSH key creation surfaces missing creds and FAILS the resource (C2)", async () => {
      // C2: Missing operator credentials means we cannot verify whether
      // the key exists. We must FAIL loudly rather than silently strip
      // KeyName, which would permanently SSH-lock-out the user if the
      // key actually already exists in AWS.
      const state = makeState({
        resourceType: RESOURCE_TYPES.EC2_INSTANCE,
        userIntent: "Create an EC2 instance I can SSH into",
        desiredState: {
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          KeyName: ResourceDefault.SSH_KEY_PLACEHOLDER,
          MetadataOptions: { HttpTokens: "required" },
        },
      });

      const result = await resourceProvisionerNode(state, mockProvisioner);

      // The EC2Client constructor threw; the outer catch now FAILS the
      // resource instead of silently stripping KeyName. Critical
      // assertion: the SDK send() was never invoked, so the helper
      // successfully prevented a leak to the default credential chain.
      expect(mockEc2Send).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      // CloudControl create must NOT be called — we failed the resource
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/SSH key pair verification failed/);
      expect(result.errorMessage).toMatch(/ASSIGNEE_OPERATOR_ACCESS_KEY_ID/);
      // KeyName must still be present in the returned clone (not stripped)
      expect(result.desiredState!["KeyName"]).toBe(
        ResourceDefault.SSH_KEY_PLACEHOLDER,
      );
    });

    it("requireAssigneeCredentials throws MissingAssigneeCredentialsError naming both env vars", () => {
      try {
        requireAssigneeCredentials("operator");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingAssigneeCredentialsError);
        const msg = (err as Error).message;
        expect(msg).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
        expect(msg).toContain("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY");
      }
    });
  });

  // ─── Reliability regressions (C1, C2, H8, H9, H11) ─────────────────────────
  describe("reliability regressions", () => {
    // C1: EIP reuse leak — retry that REUSES an EIP and then fails must
    // NOT release the reused EIP, otherwise the entire reuse design is
    // defeated and every retry leaks a fresh EIP.
    it("C1: does NOT release a reused EIP when CloudControl create fails on retry", async () => {
      mockEc2Send.mockReset();
      // DescribeAddresses returns an EIP already tagged with this runId
      // from a previous attempt.
      mockEc2Send.mockResolvedValueOnce({
        Addresses: [{ AllocationId: "eipalloc-reused-0abc1234def567890" }],
      });

      // CloudControl fails again on the retry.
      mockProvisioner.createResource.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.UNKNOWN,
          message: "NAT Gateway creation failed again",
        },
        null,
      ]);

      const state = makeState({
        resourceType: "AWS::EC2::NatGateway",
        runId: "run-natgw-retry-reuse-001",
        desiredState: {
          SubnetId: "subnet-0abc123def4567890",
          AllocationId: EIP_AUTO_ALLOCATE,
        },
      });
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);

      // Only DescribeAddresses should have been called — NOT ReleaseAddress,
      // because the EIP was reused (not fresh-allocated).
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
      const calls = mockEc2Send.mock.calls.map(
        (c) => (c[0] as { _type: string })._type,
      );
      expect(calls).toEqual(["DescribeAddressesCommand"]);
      expect(calls).not.toContain("ReleaseAddressCommand");

      // H9 regression: failure path must carry the cloned desiredState back
      // through the reducer so downstream retries can see the reused EIP.
      // Wave 16: dropped redundant `toBeDefined()` — the
      // `["AllocationId"]` chain below already throws on undefined.
      expect(result.desiredState!["AllocationId"]).toBe(
        "eipalloc-reused-0abc1234def567890",
      );
    });

    // C2: Transient DescribeKeyPairs throttle must FAIL the resource — never
    // silently strip KeyName, which would SSH-lock-out the user if the key
    // actually exists in AWS.
    it("C2: FAILS on transient DescribeKeyPairs throttle (does not strip KeyName)", async () => {
      mockEc2Send.mockReset();
      const throttle = new Error("Rate exceeded");
      (throttle as { name: string }).name = "Throttling";
      mockEc2Send.mockRejectedValueOnce(throttle);

      const state = makeState({
        resourceType: RESOURCE_TYPES.EC2_INSTANCE,
        userIntent: "Create an EC2 instance I can SSH into",
        desiredState: {
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          KeyName: ResourceDefault.SSH_KEY_PLACEHOLDER,
          MetadataOptions: { HttpTokens: "required" },
        },
      });

      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/SSH key pair verification failed/);
      expect(result.errorMessage).toMatch(/Rate exceeded/);
      // KeyName must NOT be stripped
      expect(result.desiredState!["KeyName"]).toBe(
        ResourceDefault.SSH_KEY_PLACEHOLDER,
      );
      // CloudControl must NOT be called
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
      // Only the DescribeKeyPairs attempt happened
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });

    // H8: structuredClone must deep-clone nested CFN properties. A shallow
    // spread would leave nested Tags / PolicyDocument arrays shared with the
    // caller's state.desiredState and injectMandatoryTags would mutate them.
    it("H8: deep-clones nested CFN properties (original nested Tags unchanged)", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "h8-deep-clone-token" },
      ]);

      const originalNestedTags = [
        { Key: "env", Value: "prod" },
        { Key: "team", Value: "platform" },
      ];
      const originalPolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" },
        ],
      };

      const state = makeState({
        resourceType: "AWS::IAM::Role",
        desiredState: {
          RoleName: "h8-deep-clone-role",
          AssumeRolePolicyDocument: originalPolicyDocument,
          Tags: originalNestedTags,
        },
      });

      const originalDesiredStateRef = state.desiredState;
      const originalDeepClone = structuredClone(state.desiredState);

      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);

      // Identity: top-level reference must be unchanged
      expect(state.desiredState).toBe(originalDesiredStateRef);

      // Nested arrays/objects on the ORIGINAL must be identity-stable AND
      // deep-equal to their pre-invocation snapshot. If we shallow-cloned,
      // injectMandatoryTags would have pushed assignee-run-id into this
      // same array reference.
      expect(state.desiredState!["Tags"]).toBe(originalNestedTags);
      expect(originalNestedTags).toHaveLength(2);
      expect(originalNestedTags).toEqual([
        { Key: "env", Value: "prod" },
        { Key: "team", Value: "platform" },
      ]);
      expect(state.desiredState!["AssumeRolePolicyDocument"]).toBe(
        originalPolicyDocument,
      );
      expect(state.desiredState).toEqual(originalDeepClone);

      // The mandatory tags SHOULD be present on the JSON that went to
      // CloudControl — proving we mutated the clone, not the original.
      // Wave 16: strengthened — assert sentJson is a non-empty string.
      // `JSON.parse` would throw on undefined but silently accept
      // `"null"` or other nonsense; the explicit shape check catches
      // regressions where createResource is called with the wrong
      // positional argument.
      const sentJson = mockProvisioner.createResource.mock.calls[0]![1] as
        | string
        | undefined;
      expect(typeof sentJson).toBe("string");
      expect((sentJson as string).length).toBeGreaterThan(0);
      const sent = JSON.parse(sentJson as string) as Record<string, unknown>;
      const sentTags = sent["Tags"] as { Key: string; Value: string }[];
      expect(sentTags.length).toBeGreaterThan(originalNestedTags.length);
      expect(sentTags).toEqual(
        expect.arrayContaining([
          { Key: "env", Value: "prod" },
          { Key: "team", Value: "platform" },
          expect.objectContaining({
            Key: "assignee-run-id",
            Value: "run-prov-test-001",
          }),
        ]),
      );
    });

    // H9: every failure return must carry the cloned desiredState back
    // through the reducer. Without this, allocated EIPs / resolved IDs are
    // dropped and the next retry leaks a fresh resource.
    it("H9: CloudControl failure return includes cloned desiredState", async () => {
      mockEc2Send.mockReset();
      // Fresh EIP allocation succeeds
      mockEc2Send
        .mockResolvedValueOnce({ Addresses: [] })
        .mockResolvedValueOnce({
          AllocationId: "eipalloc-h9-fresh-00112233",
        })
        .mockResolvedValueOnce({}) // CreateTags
        .mockResolvedValueOnce({}); // ReleaseAddress cleanup

      mockProvisioner.createResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.UNKNOWN, message: "boom" },
        null,
      ]);

      const state = makeState({
        resourceType: "AWS::EC2::NatGateway",
        runId: "run-natgw-h9-001",
        desiredState: {
          SubnetId: "subnet-0abc123def4567890",
          AllocationId: EIP_AUTO_ALLOCATE,
        },
      });
      const result = await resourceProvisionerNode(state, mockProvisioner);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      // Must surface the cloned desiredState even on failure.
      // Wave 16: dropped redundant `toBeDefined()` — the `![SubnetId]`
      // chain and `not.toBe(ref)` already require a real object.
      expect(result.desiredState).not.toBe(state.desiredState);
      expect(result.desiredState!["SubnetId"]).toBe("subnet-0abc123def4567890");
    });

    // H11: Two consecutive invocations with the same (runId,
    // currentResourceIndex) pair must produce DIFFERENT ClientTokens so
    // CloudControl treats retries as new requests rather than returning the
    // cached prior failure record.
    it("H11: consecutive retries produce different ClientTokens for same runId+index", async () => {
      mockProvisioner.createResource
        .mockResolvedValueOnce([null, { requestToken: "h11-req-1" }])
        .mockResolvedValueOnce([null, { requestToken: "h11-req-2" }]);

      const baseState = () =>
        makeState({
          resourceType: "AWS::IAM::Role",
          runId: "run-h11-retry-token-001",
          currentResourceIndex: 3,
          desiredState: {
            RoleName: "h11-role",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "lambda.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
          },
        });

      mockProvisioner.getResource.mockResolvedValue([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);

      await resourceProvisionerNode(baseState(), mockProvisioner);
      await resourceProvisionerNode(baseState(), mockProvisioner);

      expect(mockProvisioner.createResource).toHaveBeenCalledTimes(2);
      const token1 = mockProvisioner.createResource.mock.calls[0]![2] as
        | string
        | undefined;
      const token2 = mockProvisioner.createResource.mock.calls[1]![2] as
        | string
        | undefined;

      // Wave 16: strengthened — assert both tokens are non-empty
      // strings. `toBeDefined()` would pass for `""` or a number,
      // neither of which would be a valid CloudControl ClientToken.
      expect(typeof token1).toBe("string");
      expect(typeof token2).toBe("string");
      expect((token1 as string).length).toBeGreaterThan(0);
      expect((token2 as string).length).toBeGreaterThan(0);
      // Both must contain the runId and index as a prefix
      expect(token1).toMatch(/^run-h11-retry-token-001-3-/);
      expect(token2).toMatch(/^run-h11-retry-token-001-3-/);
      // But must be DIFFERENT — this is the whole point of H11
      expect(token1).not.toBe(token2);
    });

    // V1 N1: The attempt suffix must be 12 hex chars (48 bits of entropy).
    // The previous 8-char slice gave only 32 bits, with a birthday-paradox
    // collision boundary at ~65k retries. 12 chars pushes that boundary to
    // ~16.7M retries, well outside any realistic loop.
    it("V1 N1: attempt suffix is 12 hex characters (48 bits of entropy)", async () => {
      mockProvisioner.createResource.mockResolvedValue([
        null,
        { requestToken: "v1n1-req" },
      ]);
      mockProvisioner.getResource.mockResolvedValue([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);

      await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          runId: "run-v1n1-entropy",
          currentResourceIndex: 0,
          desiredState: {
            RoleName: "v1n1-role",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "lambda.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
          },
        }),
        mockProvisioner,
      );

      const token = mockProvisioner.createResource.mock.calls[0]![2] as string;
      // No index suffix when currentResourceIndex === 0; format is
      // `${runId}-${attemptSuffix}` where attemptSuffix is 12 lowercase hex.
      const match = token.match(/^run-v1n1-entropy-([0-9a-f]+)$/);
      expect(match).not.toBeNull();
      expect(match![1]!.length).toBe(12);
    });

    it("V1 N1: 1000 sequential attempt suffixes are all unique (collision-resistance smoke test)", async () => {
      mockProvisioner.createResource.mockResolvedValue([
        null,
        { requestToken: "v1n1-uniq" },
      ]);
      mockProvisioner.getResource.mockResolvedValue([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);

      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        await resourceProvisionerNode(
          makeState({
            resourceType: "AWS::IAM::Role",
            runId: "run-v1n1-uniq",
            currentResourceIndex: 0,
            desiredState: {
              RoleName: `v1n1-role-${i}`,
              AssumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "lambda.amazonaws.com" },
                    Action: "sts:AssumeRole",
                  },
                ],
              },
            },
          }),
          mockProvisioner,
        );
      }

      for (const call of mockProvisioner.createResource.mock.calls) {
        const t = call[2] as string;
        const suffix = t.split("-").pop()!;
        seen.add(suffix);
      }
      expect(seen.size).toBe(1000);
    });
  });

  // ── M-R4: state guard with unresolved compound identifier ────────────────
  // For compound resources whose primary identifier interpolates an unknown
  // parent ARN, getPrimaryIdentifier returns undefined and the state guard
  // is skipped. We MUST log a warn-level audit event so operators can detect
  // duplicate-resource sneak-throughs. The provisioning still proceeds.
  describe("state guard skipped on unresolved identifier (M-R4)", () => {
    it("logs STATE_GUARD_SKIPPED_UNRESOLVED_IDENTIFIER and proceeds when getPrimaryIdentifier returns undefined", async () => {
      // EC2 Route — composite identifier (RouteTableId + DestinationCidrBlock)
      // that getPrimaryIdentifier may return undefined for, depending on
      // the shape of desiredState. We use the absence of RouteTableId so
      // the helper cannot resolve a primary identifier.
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "route-mr4-token" },
      ]);

      const stderrSpy = vi.spyOn(process.stderr, "write");

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::EC2::Route",
          desiredState: {
            // Intentionally omit RouteTableId so the primary identifier
            // cannot be resolved.
            DestinationCidrBlock: "0.0.0.0/0",
            GatewayId: "igw-0123456789abcdef0",
          },
        }),
        mockProvisioner,
      );

      // The state guard must NOT have been called (no identifier).
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
      // Provisioning still proceeds.
      expect(mockProvisioner.createResource).toHaveBeenCalledTimes(1);
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      // Warn-level audit log must have been emitted with the new action.
      const allWrites = stderrSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .join("\n");
      expect(allWrites).toContain("state_guard_skipped_unresolved_identifier");
      stderrSpy.mockRestore();
    });
  });

  // ── M-R8: safeKeyName whitelist ──────────────────────────────────────────
  // The previous sanitizer only stripped `/`, `\`, and `..`, leaving
  // null bytes, leading dots, control chars, and other shell-unsafe
  // characters intact. The whitelist `[A-Za-z0-9._-]` blocks all of those.
  describe("sanitizeKeyName (M-R8)", () => {
    it("preserves safe characters", () => {
      expect(sanitizeKeyName("assignee-ssh-key")).toBe("assignee-ssh-key");
      expect(sanitizeKeyName("my_key.v2")).toBe("my_key.v2");
      expect(sanitizeKeyName("Key-2026-04")).toBe("Key-2026-04");
    });

    it("replaces path separators", () => {
      expect(sanitizeKeyName("foo/bar")).toBe("foo_bar");
      expect(sanitizeKeyName("foo\\bar")).toBe("foo_bar");
      expect(sanitizeKeyName("../etc/passwd")).toBe("etc_passwd");
    });

    it("rejects null bytes", () => {
      expect(sanitizeKeyName("good\u0000bad")).toBe("good_bad");
    });

    it("strips leading dots so the result is never a dotfile", () => {
      expect(sanitizeKeyName(".hidden")).toBe("hidden");
      expect(sanitizeKeyName("..bad")).toBe("bad");
      expect(sanitizeKeyName("...")).toBe("assignee_key");
    });

    it("replaces control characters and newlines", () => {
      expect(sanitizeKeyName("foo\nbar")).toBe("foo_bar");
      expect(sanitizeKeyName("foo\tbar")).toBe("foo_bar");
      expect(sanitizeKeyName("foo\rbar")).toBe("foo_bar");
    });

    it("replaces shell metacharacters", () => {
      expect(sanitizeKeyName("foo;rm -rf /")).toBe("foo_rm_-rf__");
      expect(sanitizeKeyName("foo$(whoami)")).toBe("foo__whoami_");
      expect(sanitizeKeyName("foo`id`")).toBe("foo_id_");
    });

    it("replaces non-ASCII Unicode", () => {
      expect(sanitizeKeyName("résumé")).toBe("r_sum_");
    });

    it("returns a deterministic placeholder for empty/all-stripped input", () => {
      expect(sanitizeKeyName("")).toBe("assignee_key");
      // 4 forward slashes → 4 underscores → leading-strip leaves empty
      // → placeholder.
      expect(sanitizeKeyName("////")).toBe("assignee_key");
      expect(sanitizeKeyName(".....")).toBe("assignee_key");
    });
  });

  // L-A5 regression: catch-block extras must include the FULL stack trace
  // (not just String(err) which discards it). Operators diagnosing EIP/SSH
  // leaks need the stack to find the exact AWS SDK call that failed.
  describe("formatErrorForLog (L-A5)", () => {
    it("returns the stack trace when err is an Error with a stack", () => {
      const err = new Error("DescribeAddresses failed");
      // Node sets err.stack on construction; sanity check it's a string.
      // Tier C: strengthened — typeof string instead of just defined
      expect(typeof err.stack).toBe("string");
      const formatted = formatErrorForLog(err);
      expect(formatted).toBe(err.stack);
      expect(formatted).toContain("DescribeAddresses failed");
      // The stack must mention this test file (proves it's a real stack).
      expect(formatted).toContain("resource-provisioner.test");
    });

    it("falls back to err.message when stack is undefined", () => {
      const err = new Error("no stack");
      // Force-clear stack to simulate the (rare) Error subclass that omits it.
      Object.defineProperty(err, "stack", { value: undefined });
      expect(formatErrorForLog(err)).toBe("no stack");
    });

    it("stringifies non-Error throws", () => {
      expect(formatErrorForLog("oops")).toBe("oops");
      expect(formatErrorForLog(42)).toBe("42");
      expect(formatErrorForLog({ kind: "weird" })).toBe("[object Object]");
    });

    it("preserves AWS SDK error subclass stack traces", () => {
      class ThrottlingException extends Error {
        constructor() {
          super("Rate exceeded");
          this.name = "ThrottlingException";
        }
      }
      const err = new ThrottlingException();
      const formatted = formatErrorForLog(err);
      expect(formatted).toContain("Rate exceeded");
      expect(formatted).toContain("ThrottlingException");
    });
  });

  // L-A6 regression: when DescribeAddresses returns more than one EIP tagged
  // with the runId (from prior leaked attempts), we must reuse the first one
  // AND emit a warn-level log so operators can manually clean up the rest.
  describe("EIP multi-address leak warning (L-A6)", () => {
    let loggerModule: typeof import("../../utils/logger/index.js");
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      loggerModule = await import("../../utils/logger/index.js");
      logSpy = vi.spyOn(loggerModule, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it("emits a warn log when DescribeAddresses returns multiple EIPs", async () => {
      mockEc2Send.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === "DescribeAddressesCommand") {
          return Promise.resolve({
            Addresses: [
              {
                AllocationId: "eipalloc-aaaaaaaa",
                PublicIp: "203.0.113.10",
              },
              {
                AllocationId: "eipalloc-bbbbbbbb",
                PublicIp: "203.0.113.11",
              },
              {
                AllocationId: "eipalloc-cccccccc",
                PublicIp: "203.0.113.12",
              },
            ],
          });
        }
        // CreateResource path will be reached after the EIP reuse — return
        // a benign success so the node returns IN_PROGRESS.
        return Promise.resolve({});
      });

      mockProvisioner.getResource.mockResolvedValue([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "not found" },
        undefined,
      ]);
      mockProvisioner.createResource.mockResolvedValue([
        undefined,
        { requestToken: "tok-001" },
      ]);

      const state = makeState({
        resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
        desiredState: {
          [CfnKey.ALLOCATION_ID]: EIP_AUTO_ALLOCATE,
          SubnetId: "subnet-12345678",
        },
      });

      await resourceProvisionerNode(state, mockProvisioner);

      // Find the warn-level call describing the leak.
      const leakWarn = logSpy.mock.calls.find((args) => {
        const event = args[0] as {
          level?: string;
          extras?: Record<string, unknown>;
        };
        return (
          event.level === "warn" &&
          event.extras?.["reason"] === "eip_leak_detected"
        );
      });
      // Wave 16: strengthened — the leak-warn entry MUST be produced
      // by the eip_leak_detected path. The previous `toBeDefined()`
      // would have passed on any matching find() result, but the
      // subsequent `.extras` chain below was the real assertion. Make
      // the shape check explicit so a regression that changes the
      // logger signature (arg[0] no longer the event) fails here
      // instead of at the cryptic `.extras["count"]` line below.
      expect(leakWarn).toBeTruthy();
      expect(leakWarn!.length).toBeGreaterThan(0);
      const event = leakWarn![0] as {
        extras: Record<string, unknown>;
      };
      expect(event.extras["count"]).toBe(3);
      expect(event.extras["reusedAllocationId"]).toBe("eipalloc-aaaaaaaa");
      expect(event.extras["allAllocationIds"]).toEqual([
        "eipalloc-aaaaaaaa",
        "eipalloc-bbbbbbbb",
        "eipalloc-cccccccc",
      ]);
    });

    it("does NOT emit a leak warn when DescribeAddresses returns exactly one EIP", async () => {
      mockEc2Send.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === "DescribeAddressesCommand") {
          return Promise.resolve({
            Addresses: [
              {
                AllocationId: "eipalloc-aaaaaaaa",
                PublicIp: "203.0.113.10",
              },
            ],
          });
        }
        return Promise.resolve({});
      });

      mockProvisioner.getResource.mockResolvedValue([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "not found" },
        undefined,
      ]);
      mockProvisioner.createResource.mockResolvedValue([
        undefined,
        { requestToken: "tok-002" },
      ]);

      const state = makeState({
        resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
        desiredState: {
          [CfnKey.ALLOCATION_ID]: EIP_AUTO_ALLOCATE,
          SubnetId: "subnet-12345678",
        },
      });

      await resourceProvisionerNode(state, mockProvisioner);

      const leakWarn = logSpy.mock.calls.find((args) => {
        const event = args[0] as {
          level?: string;
          extras?: Record<string, unknown>;
        };
        return (
          event.level === "warn" &&
          event.extras?.["reason"] === "eip_leak_detected"
        );
      });
      expect(leakWarn).toBeUndefined();
    });
  });
});
