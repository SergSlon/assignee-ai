import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MissingAssigneeCredentialsError } from "@assignee/core";
import { requireAssigneeCredentials } from "../config/aws-credentials.js";
import {
  ExecutionStatus,
  EIP_AUTO_ALLOCATE,
  ResourceDefault,
  CfnKey,
  RESOURCE_TYPES,
} from "@assignee/core";
import { resourceProvisionerNode } from "./resource-provisioner.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "../services/provisioning-port.js";
import type { SDKFallbackDispatcher } from "../services/sdk-fallback-dispatcher.js";

// ── EC2 SDK mock for EIP allocation tests ─────────────────────────────────
const { mockEc2Send } = vi.hoisted(() => ({
  mockEc2Send: vi.fn(),
}));

vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: mockEc2Send })),
  AllocateAddressCommand: vi.fn().mockImplementation((input: unknown) => ({
    _type: "AllocateAddressCommand",
    input,
  })),
  DescribeAddressesCommand: vi.fn().mockImplementation((input: unknown) => ({
    _type: "DescribeAddressesCommand",
    input,
  })),
  CreateTagsCommand: vi.fn().mockImplementation((input: unknown) => ({
    _type: "CreateTagsCommand",
    input,
  })),
  ReleaseAddressCommand: vi.fn().mockImplementation((input: unknown) => ({
    _type: "ReleaseAddressCommand",
    input,
  })),
  DescribeKeyPairsCommand: vi.fn().mockImplementation((input: unknown) => ({
    _type: "DescribeKeyPairsCommand",
    input,
  })),
  CreateKeyPairCommand: vi.fn().mockImplementation((input: unknown) => ({
    _type: "CreateKeyPairCommand",
    input,
  })),
  DeleteKeyPairCommand: vi.fn().mockImplementation((input: unknown) => ({
    _type: "DeleteKeyPairCommand",
    input,
  })),
}));

// ── FS mocks for SSH key pair creation ───────────────────────────────────────
const { mockMkdirSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
}));

vi.mock("node:os", () => ({
  homedir: vi.fn().mockReturnValue("/home/testuser"),
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
      expect(mockProvisioner.createResource).toHaveBeenCalled();
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

      const result = await resourceProvisionerNode(
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
      expect(mockProvisioner.createResource).toHaveBeenCalled();
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
      expect(mockProvisioner.createResource).toHaveBeenCalled();
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
      expect(mockProvisioner.createResource).toHaveBeenCalled();
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
      expect(result.startedAt).toBeDefined();

      expect(mockProvisioner.getResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        "poc-role-test",
      );
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        expect.stringContaining("poc-role-test"),
        "run-prov-test-001",
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

  // ── SDK Fallback Dispatcher Tests (Story 7.7) ─────────────────────────────

  describe("SDK fallback dispatch (Story 7.7)", () => {
    function createMockFallbackDispatcher(): {
      canHandle: ReturnType<typeof vi.fn>;
      isRedirect: ReturnType<typeof vi.fn>;
      createEventSourceMapping: ReturnType<typeof vi.fn>;
      subscribe: ReturnType<typeof vi.fn>;
    } {
      return {
        canHandle: vi.fn().mockReturnValue(false),
        isRedirect: vi.fn().mockReturnValue(null),
        createEventSourceMapping: vi.fn(),
        subscribe: vi.fn(),
      };
    }

    let mockFallback: ReturnType<typeof createMockFallbackDispatcher>;

    beforeEach(() => {
      mockFallback = createMockFallbackDispatcher();
    });

    it("dispatches EventSourceMapping via SDK fallback and returns SUCCESS with UUID", async () => {
      mockFallback.canHandle.mockReturnValue(true);
      mockFallback.createEventSourceMapping.mockResolvedValueOnce([
        null,
        { identifier: "esm-uuid-1234" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::Lambda::EventSourceMapping",
          desiredState: {
            EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:queue",
            FunctionName: "my-function",
          },
        }),
        mockProvisioner,
        mockFallback as unknown as SDKFallbackDispatcher,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
      expect(result.resourceArn).toBe("esm-uuid-1234");
      expect(mockFallback.canHandle).toHaveBeenCalledWith(
        "AWS::Lambda::EventSourceMapping",
      );
      expect(mockFallback.createEventSourceMapping).toHaveBeenCalled();
      // Should NOT have gone through CloudControl path
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
    });

    it("dispatches SNS Subscription via SDK fallback and returns SUCCESS with ARN", async () => {
      mockFallback.canHandle.mockReturnValue(true);
      mockFallback.subscribe.mockResolvedValueOnce([
        null,
        {
          identifier: "arn:aws:sns:us-east-1:123456789012:my-topic:sub-id",
        },
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
        mockFallback as unknown as SDKFallbackDispatcher,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
      expect(result.resourceArn).toBe(
        "arn:aws:sns:us-east-1:123456789012:my-topic:sub-id",
      );
      expect(mockFallback.subscribe).toHaveBeenCalled();
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("returns FAILED with redirect message for Lambda::Permission", async () => {
      mockFallback.isRedirect.mockReturnValue({
        redirect: true,
        message:
          "AWS::Lambda::Permission is not supported by CCAPI. Use AWS::Lambda::PermissionPolicy instead.",
      });

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
        mockFallback as unknown as SDKFallbackDispatcher,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /AWS::Lambda::Permission is not supported by CCAPI/,
      );
      expect(result.errorMessage).toMatch(/PermissionPolicy/);
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("returns FAILED with redirect message for ElastiCache::ReplicationGroup", async () => {
      mockFallback.isRedirect.mockReturnValue({
        redirect: true,
        message:
          "ElastiCache ReplicationGroup is not supported. Use AWS::ElastiCache::ServerlessCache for Redis/Memcached.",
      });

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::ElastiCache::ReplicationGroup",
          desiredState: {
            ReplicationGroupDescription: "test",
          },
        }),
        mockProvisioner,
        mockFallback as unknown as SDKFallbackDispatcher,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /ElastiCache ReplicationGroup is not supported/,
      );
      expect(result.errorMessage).toMatch(/ServerlessCache/);
      expect(mockProvisioner.getResource).not.toHaveBeenCalled();
    });

    it("falls through to CloudControl path for standard types when fallback dispatcher present", async () => {
      mockFallback.canHandle.mockReturnValue(false);
      mockFallback.isRedirect.mockReturnValue(null);

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
        mockFallback as unknown as SDKFallbackDispatcher,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("standard-token");
      expect(mockProvisioner.getResource).toHaveBeenCalled();
    });

    it("returns FAILED when SDK fallback createEventSourceMapping fails", async () => {
      mockFallback.canHandle.mockReturnValue(true);
      mockFallback.createEventSourceMapping.mockResolvedValueOnce([
        {
          kind: ProvisioningErrorKind.NOT_FOUND,
          message: "Function not found",
        },
        null,
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::Lambda::EventSourceMapping",
          desiredState: {
            EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:queue",
            FunctionName: "nonexistent",
          },
        }),
        mockProvisioner,
        mockFallback as unknown as SDKFallbackDispatcher,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/SDK fallback provisioning failed/);
      expect(result.errorMessage).toMatch(/Function not found/);
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
      expect(mockProvisioner.createResource).toHaveBeenCalled();
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
      expect(state.desiredState!["AllocationId"]).toBe("eipalloc-new-001");

      // Verify CreateTags was called to tag the EIP for retry tracking
      const createTagsCall = mockEc2Send.mock.calls[2]![0] as {
        _type: string;
        input: { Resources: string[]; Tags: { Key: string; Value: string }[] };
      };
      expect(createTagsCall._type).toBe("CreateTagsCommand");
      expect(createTagsCall.input.Resources).toEqual(["eipalloc-new-001"]);
      expect(createTagsCall.input.Tags).toEqual([
        { Key: "assignee:runId", Value: "run-natgw-eip-001" },
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
      expect(state.desiredState!["AllocationId"]).toBe("eipalloc-existing-999");

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
      expect(state.desiredState!["AllocationId"]).toBe("eipalloc-fallback-001");
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
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("keys"),
        { recursive: true },
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
      expect(state.desiredState!["KeyName"]).toBeUndefined();
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    });

    it("rethrows permission errors from DescribeKeyPairs (not assumed as 'not found')", async () => {
      // DescribeKeyPairs throws a permission error — should NOT assume key doesn't exist
      const accessDenied = new Error("User not authorized");
      (accessDenied as { name: string }).name = "UnauthorizedAccess";
      mockEc2Send.mockRejectedValueOnce(accessDenied);

      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "ec2-perm-err-token" },
      ]);

      const state = makeEc2State();
      const result = await resourceProvisionerNode(state, mockProvisioner);

      // Should have caught the rethrown error — KeyName removed, provision continues
      expect(state.desiredState!["KeyName"]).toBeUndefined();
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      // Should NOT have tried CreateKeyPair
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
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
      expect(state.desiredState!["KeyName"]).toBeUndefined();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
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

    it("EC2 SSH key creation surfaces missing creds and never calls SDK", async () => {
      mockProvisioner.createResource.mockResolvedValue([
        null,
        { requestToken: "ssh-failclosed" },
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

      const result = await resourceProvisionerNode(state, mockProvisioner);

      // The SSH-key try-block catches the error and removes KeyName,
      // letting CloudControl proceed. Critical assertion: the SDK send()
      // was never invoked, so the helper successfully prevented a leak
      // to the default credential chain.
      expect(mockEc2Send).not.toHaveBeenCalled();
      expect(state.desiredState!["KeyName"]).toBeUndefined();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      // CloudControl create should still proceed since this hook is non-fatal
      expect(mockProvisioner.createResource).toHaveBeenCalled();
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
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
});
