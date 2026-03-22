import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import { resourceProvisionerNode } from "./resource-provisioner.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "../services/provisioning-port.js";
import type { SDKFallbackDispatcher } from "../services/sdk-fallback-dispatcher.js";

// ── Mock provisioning port ──────────────────────────────────────────────────

function createMockProvisioner(): ProvisioningPort & {
  getResource: ReturnType<typeof vi.fn>;
  createResource: ReturnType<typeof vi.fn>;
  getRequestStatus: ReturnType<typeof vi.fn>;
  deleteResource: ReturnType<typeof vi.fn>;
} {
  return {
    getResource: vi.fn(),
    createResource: vi.fn(),
    getRequestStatus: vi.fn(),
    deleteResource: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockProvisioner = createMockProvisioner();
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
        makeState(),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/Stale Plan/);
      expect(result.errorMessage).toMatch(/poc-smoke-test/);
      expect(mockProvisioner.getResource).toHaveBeenCalledWith(
        "AWS::S3::Bucket",
        "poc-smoke-test",
      );
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
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
        makeState(),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("0ff011d6-654f-4110-8a37-9754bd6aad59");
    });

    it("fails when getResource throws a non-NOT_FOUND error", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.UNKNOWN, message: "Access denied" },
        null,
      ]);

      const result = await resourceProvisionerNode(
        makeState(),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /State Guard: unable to verify resource state/,
      );
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
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
        makeState(),
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
        makeState(),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("0ff011d6-654f-4110-8a37-9754bd6aad59");
      expect(result.startedAt).toBeDefined();

      expect(mockProvisioner.getResource).toHaveBeenCalledWith(
        "AWS::S3::Bucket",
        "poc-smoke-test",
      );
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::S3::Bucket",
        expect.stringContaining("poc-smoke-test"),
        "run-prov-test-001",
      );
    });

    it("injects mandatory tags into createResource desiredState", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
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
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
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
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
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
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
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
      expect(result.errorMessage).toMatch(/already exists/i);
      expect(result.errorMessage).toMatch(/CloudControl provisioning failed/);
    });

    it("maps THROTTLED to FAILED with 'throttled' message", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
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
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
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
        makeState(),
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
});
