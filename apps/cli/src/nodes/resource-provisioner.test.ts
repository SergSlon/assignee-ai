import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";

// ── SDK mock ──────────────────────────────────────────────────────────────────
const mockSend = vi.fn();

vi.mock("../services/cloudcontrol-client.js", () => ({
  getCloudControlClient: () => ({ send: mockSend }),
}));

vi.mock("@aws-sdk/client-cloudcontrol", () => ({
  CloudControlClient: vi.fn(),
  GetResourceCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
  CreateResourceCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));

import { resourceProvisionerNode } from "./resource-provisioner.js";
import {
  GetResourceCommand,
  CreateResourceCommand,
} from "@aws-sdk/client-cloudcontrol";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** ResourceNotFoundException error — SDK throws this when resource is not found */
function makeResourceNotFoundError(): Error {
  return Object.assign(new Error("Resource not found"), {
    name: "ResourceNotFoundException",
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
      );
      expect(result).toEqual({});
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("fails when desiredState is missing", async () => {
      const result = await resourceProvisionerNode(
        makeState({ desiredState: undefined }),
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/desiredState is missing/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("fails when resourceType is empty string (Story 9.1: isResourceType guard)", async () => {
      const result = await resourceProvisionerNode(
        makeState({ resourceType: "" }),
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

      const result = await resourceProvisionerNode(makeState());

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

      const result = await resourceProvisionerNode(makeState());

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("0ff011d6-654f-4110-8a37-9754bd6aad59");
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("fails when GetResourceCommand throws a non-ResourceNotFoundException error", async () => {
      const accessDenied = Object.assign(new Error("Access denied"), {
        name: "AccessDeniedException",
      });
      mockSend.mockRejectedValueOnce(accessDenied);

      const result = await resourceProvisionerNode(makeState());

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

      const result = await resourceProvisionerNode(makeState());

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

      await resourceProvisionerNode(makeState());

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

      const result = await resourceProvisionerNode(makeState());

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/no RequestToken/);
    });

    it("fails when CreateResourceCommand returns ProgressEvent with no RequestToken", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      mockSend.mockResolvedValueOnce({ ProgressEvent: {} });

      const result = await resourceProvisionerNode(makeState());

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/no RequestToken/);
    });
  });

  describe("error handling — CreateResourceCommand failures", () => {
    it("fails when CreateResourceCommand throws (e.g. BucketAlreadyExists race condition)", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError()); // state guard passes
      mockSend.mockRejectedValueOnce(
        new Error(
          'Resource handler returned message: "BucketAlreadyOwnedByYou" (HandlerErrorCode: AlreadyExists)',
        ),
      );

      const result = await resourceProvisionerNode(makeState());

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/CloudControl provisioning failed/);
      expect(result.errorMessage).toMatch(/BucketAlreadyOwnedByYou/);
    });

    it("fails when CreateResourceCommand throws with non-Error (bad credentials)", async () => {
      mockSend.mockRejectedValueOnce(makeResourceNotFoundError());
      mockSend.mockRejectedValueOnce(
        new Error(
          "Unable to locate credentials. You can configure credentials by running 'aws configure'.",
        ),
      );

      const result = await resourceProvisionerNode(makeState());

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/CloudControl provisioning failed/);
      expect(result.errorMessage).toMatch(/Unable to locate credentials/);
    });
  });
});
