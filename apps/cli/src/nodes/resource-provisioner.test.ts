import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";

// ── SDK mock ──────────────────────────────────────────────────────────────────
// Use importOriginal to preserve real exception classes for instanceof checks.
vi.mock("@aws-sdk/client-cloudcontrol", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@aws-sdk/client-cloudcontrol")>();
  return {
    ...actual,
    CloudControlClient: vi.fn(),
    GetResourceCommand: vi
      .fn()
      .mockImplementation((input: unknown) => ({ input })),
    CreateResourceCommand: vi
      .fn()
      .mockImplementation((input: unknown) => ({ input })),
  };
});

import { resourceProvisionerNode } from "./resource-provisioner.js";
import {
  GetResourceCommand,
  CreateResourceCommand,
  ResourceNotFoundException,
  AlreadyExistsException,
  ThrottlingException,
} from "@aws-sdk/client-cloudcontrol";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockSend = vi.fn();
const mockClient = { send: mockSend } as unknown as CloudControlClient;

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

/** Real ResourceNotFoundException instance for instanceof checks. */
function makeResourceNotFoundError(): ResourceNotFoundException {
  return new ResourceNotFoundException({
    message: "Resource not found",
    $metadata: {},
  });
}

/** Default happy-path create response */
const CREATE_RESPONSE = {
  ProgressEvent: {
    RequestToken: "0ff011d6-654f-4110-8a37-9754bd6aad59",
    OperationStatus: "IN_PROGRESS",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resourceProvisionerNode", () => {
  describe("pre-flight guards", () => {
    it("returns empty when executionStatus is CANCELLED", async () => {
      const result = await resourceProvisionerNode(
        makeState({ executionStatus: ExecutionStatus.CANCELLED }),
        mockClient,
      );
      expect(result).toEqual({});
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("fails when desiredState is missing", async () => {
      const result = await resourceProvisionerNode(
        makeState({ desiredState: undefined }),
        mockClient,
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/desiredState is missing/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("fails when resourceType is empty string (Story 9.1: isResourceType guard)", async () => {
      const result = await resourceProvisionerNode(
        makeState({ resourceType: "" }),
        mockClient,
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /unsupported or missing resourceType/,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("fails when resourceType is not a known ResourceType (Story 9.1: isResourceType guard)", async () => {
      const result = await resourceProvisionerNode(
        makeState({ resourceType: "AWS::Fake::Resource" }),
        mockClient,
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /unsupported or missing resourceType/,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("state guard (FR-15 Read-Before-Write)", () => {
    it("aborts with Stale Plan error when GetResourceCommand succeeds (resource exists)", async () => {
      // GetResourceCommand succeeds → resource already exists
      mockSend.mockResolvedValueOnce({
        ResourceDescription: { Identifier: "poc-smoke-test" },
      });

      const result = await resourceProvisionerNode(makeState(), mockClient);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/Stale Plan/);
      expect(result.errorMessage).toMatch(/poc-smoke-test/);
      // CreateResourceCommand must NOT have been called
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(GetResourceCommand).toHaveBeenCalledWith({
        TypeName: "AWS::S3::Bucket",
        Identifier: "poc-smoke-test",
      });
    });

    it("proceeds when GetResourceCommand throws ResourceNotFoundException (resource not found — safe to create)", async () => {
      // First call: GetResourceCommand throws ResourceNotFoundException
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      // Second call: CreateResourceCommand succeeds
      mockSend.mockResolvedValueOnce(CREATE_RESPONSE);

      const result = await resourceProvisionerNode(makeState(), mockClient);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("0ff011d6-654f-4110-8a37-9754bd6aad59");
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("fails when GetResourceCommand throws a non-ResourceNotFoundException error", async () => {
      const accessDenied = Object.assign(new Error("Access denied"), {
        name: "AccessDeniedException",
      });
      mockSend.mockRejectedValueOnce(accessDenied);

      const result = await resourceProvisionerNode(makeState(), mockClient);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/State Guard failed/);
      // CreateResourceCommand must NOT have been called
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("skips state guard when identifier cannot be derived (no BucketName)", async () => {
      // No BucketName → getPrimaryIdentifier returns undefined → skip state guard
      mockSend.mockResolvedValueOnce(CREATE_RESPONSE);

      const result = await resourceProvisionerNode(
        makeState({ desiredState: { Tags: [] } }),
        mockClient,
      );

      // Only CreateResourceCommand was called (no GetResourceCommand)
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(CreateResourceCommand).toHaveBeenCalled();
      expect(GetResourceCommand).not.toHaveBeenCalled();
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    });
  });

  describe("happy path — CloudControl create workflow", () => {
    it("calls GetResourceCommand then CreateResourceCommand and returns IN_PROGRESS with requestToken", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError()); // state guard
      mockSend.mockResolvedValueOnce(CREATE_RESPONSE); // create

      const result = await resourceProvisionerNode(makeState(), mockClient);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("0ff011d6-654f-4110-8a37-9754bd6aad59");
      expect(result.startedAt).toBeDefined();

      expect(GetResourceCommand).toHaveBeenCalledWith({
        TypeName: "AWS::S3::Bucket",
        Identifier: "poc-smoke-test",
      });
      expect(CreateResourceCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TypeName: "AWS::S3::Bucket",
          ClientToken: "run-prov-test-001",
        }),
      );
    });

    it("injects mandatory tags into CreateResourceCommand DesiredState", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      mockSend.mockResolvedValueOnce(CREATE_RESPONSE);

      await resourceProvisionerNode(makeState(), mockClient);

      const createCall = vi.mocked(CreateResourceCommand).mock.calls[0]![0];
      const desiredState = JSON.parse(
        (createCall as { DesiredState: string }).DesiredState,
      ) as Record<string, unknown>;

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
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      mockSend.mockResolvedValueOnce({
        ProgressEvent: {
          RequestToken: "ssm-req-token-abc",
          OperationStatus: "IN_PROGRESS",
        },
      });

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::SSM::Parameter",
          desiredState: {
            Name: "/app/config/env",
            Value: "production",
            Type: "String",
          },
        }),
        mockClient,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("ssm-req-token-abc");

      // NFR-14: SSM Parameter uses flat map Tags, not [{Key, Value}] array
      const createCall = vi.mocked(CreateResourceCommand).mock.calls[0]![0];
      const desiredState = JSON.parse(
        (createCall as { DesiredState: string }).DesiredState,
      ) as Record<string, unknown>;
      expect(Array.isArray(desiredState["Tags"])).toBe(false);
      expect(
        (desiredState["Tags"] as Record<string, string>)["managed-by"],
      ).toBe("assignee-ai");
    });

    it("works for AWS::IAM::Role with RoleName as identifier", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      mockSend.mockResolvedValueOnce({
        ProgressEvent: {
          RequestToken: "iam-req-token-xyz",
          OperationStatus: "IN_PROGRESS",
        },
      });

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "poc-lambda-role",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
          },
        }),
        mockClient,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("iam-req-token-xyz");
    });
  });

  describe("missing RequestToken guard", () => {
    it("fails when CreateResourceCommand returns no RequestToken in ProgressEvent", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      // Response with no ProgressEvent at all
      mockSend.mockResolvedValueOnce({});

      const result = await resourceProvisionerNode(makeState(), mockClient);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/no RequestToken/);
    });

    it("fails when CreateResourceCommand returns ProgressEvent with no RequestToken", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      mockSend.mockResolvedValueOnce({ ProgressEvent: {} });

      const result = await resourceProvisionerNode(makeState(), mockClient);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/no RequestToken/);
    });
  });

  describe("error handling — typed SDK exceptions (Story 9.2: AC #3)", () => {
    it("maps AlreadyExistsException to FAILED with 'already exists' message", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError()); // state guard passes
      mockSend.mockRejectedValueOnce(
        new AlreadyExistsException({
          message: "already exists",
          $metadata: {},
        }),
      );

      const result = await resourceProvisionerNode(makeState(), mockClient);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/already exists/i);
      expect(result.errorMessage).toMatch(/CloudControl provisioning failed/);
    });

    it("maps ThrottlingException to FAILED with 'throttled' message", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      mockSend.mockRejectedValueOnce(
        new ThrottlingException({ message: "Rate exceeded", $metadata: {} }),
      );

      const result = await resourceProvisionerNode(makeState(), mockClient);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/throttled/i);
    });

    it("falls back to generic message for unknown errors", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      mockSend.mockRejectedValueOnce(
        new Error("Unable to locate credentials."),
      );

      const result = await resourceProvisionerNode(makeState(), mockClient);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/CloudControl provisioning failed/);
      expect(result.errorMessage).toMatch(/Unable to locate credentials/);
    });
  });
});
