/**
 * Unit tests for cloudcontrol-adapter.ts
 * Story 9.9 — T7: cloudcontrol-adapter tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ResourceNotFoundException,
  AlreadyExistsException,
  ThrottlingException,
  GeneralServiceException,
} from "@aws-sdk/client-cloudcontrol";
import { ProvisioningErrorKind } from "./provisioning-port.js";
import { CloudControlAdapter } from "./cloudcontrol-adapter.js";

function createMockClient() {
  return { send: vi.fn() };
}

let mockClient: ReturnType<typeof createMockClient>;
let adapter: CloudControlAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = createMockClient();
  adapter = new CloudControlAdapter(mockClient as never);
});

// ── getResource ─────────────────────────────────────────────────────────────

describe("getResource", () => {
  it("T7.1: found — returns [null, result]", async () => {
    const sdkResult = {
      ResourceDescription: { Identifier: "my-bucket", Properties: "{}" },
    };
    mockClient.send.mockResolvedValue(sdkResult);

    const [err, result] = await adapter.getResource(
      "AWS::S3::Bucket",
      "my-bucket",
    );

    expect(err).toBeNull();
    expect(result).toBe(sdkResult);
  });

  it("T7.2: not found — returns NOT_FOUND error", async () => {
    mockClient.send.mockRejectedValue(
      new ResourceNotFoundException({ message: "Not found", $metadata: {} }),
    );

    const [err, result] = await adapter.getResource(
      "AWS::S3::Bucket",
      "nonexistent",
    );

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.NOT_FOUND);
    expect(result).toBeNull();
  });

  it("T7.3: access denied — returns ACCESS_DENIED error", async () => {
    const accessDeniedError = new Error("User is not authorized");
    accessDeniedError.name = "AccessDeniedException";
    mockClient.send.mockRejectedValue(accessDeniedError);

    const [err, result] = await adapter.getResource(
      "AWS::S3::Bucket",
      "restricted",
    );

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.ACCESS_DENIED);
    expect(result).toBeNull();
  });

  it("T7.4: generic error — returns UNKNOWN error", async () => {
    mockClient.send.mockRejectedValue(new Error("Network timeout"));

    const [err, result] = await adapter.getResource(
      "AWS::S3::Bucket",
      "whatever",
    );

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.UNKNOWN);
    expect(err!.message).toContain("Network timeout");
    expect(result).toBeNull();
  });
});

// ── createResource ──────────────────────────────────────────────────────────

describe("createResource", () => {
  it("T7.5: success — returns request token", async () => {
    mockClient.send.mockResolvedValue({
      ProgressEvent: { RequestToken: "token-123" },
    });

    const [err, result] = await adapter.createResource(
      "AWS::S3::Bucket",
      '{"BucketName":"test"}',
      "client-token-1",
    );

    expect(err).toBeNull();
    expect(result).not.toBeNull();
    expect(result!.requestToken).toBe("token-123");
  });

  it("T7.6: already exists — returns ALREADY_EXISTS error", async () => {
    mockClient.send.mockRejectedValue(
      new AlreadyExistsException({
        message: "Bucket already exists",
        $metadata: {},
      }),
    );

    const [err, result] = await adapter.createResource(
      "AWS::S3::Bucket",
      '{"BucketName":"existing"}',
      "client-token-2",
    );

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.ALREADY_EXISTS);
    expect(result).toBeNull();
  });

  it("T7.7: throttled — returns THROTTLED error", async () => {
    mockClient.send.mockRejectedValue(
      new ThrottlingException({
        message: "Rate exceeded",
        $metadata: {},
      }),
    );

    const [err, result] = await adapter.createResource(
      "AWS::S3::Bucket",
      '{"BucketName":"throttled"}',
      "client-token-3",
    );

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.THROTTLED);
    expect(result).toBeNull();
  });

  it("T7.8: generic error — returns UNKNOWN error", async () => {
    mockClient.send.mockRejectedValue(new Error("Unexpected"));

    const [err, result] = await adapter.createResource(
      "AWS::S3::Bucket",
      '{"BucketName":"error"}',
      "client-token-4",
    );

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.UNKNOWN);
    expect(result).toBeNull();
  });

  it("no RequestToken in response — returns UNKNOWN error", async () => {
    mockClient.send.mockResolvedValue({ ProgressEvent: {} });

    const [err, result] = await adapter.createResource(
      "AWS::S3::Bucket",
      '{"BucketName":"notoken"}',
      "client-token-5",
    );

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.UNKNOWN);
    expect(err!.message).toContain("no RequestToken");
    expect(result).toBeNull();
  });
});

// ── deleteResource ──────────────────────────────────────────────────────────

describe("deleteResource", () => {
  it("T7.9: success — returns request token", async () => {
    mockClient.send.mockResolvedValue({
      ProgressEvent: { RequestToken: "delete-token-1" },
    });

    const [err, result] = await adapter.deleteResource(
      "AWS::S3::Bucket",
      "my-bucket",
    );

    expect(err).toBeNull();
    expect(result).not.toBeNull();
    expect(result!.requestToken).toBe("delete-token-1");
  });

  it("delete not found — returns NOT_FOUND error", async () => {
    mockClient.send.mockRejectedValue(
      new ResourceNotFoundException({
        message: "Resource not found",
        $metadata: {},
      }),
    );

    const [err, result] = await adapter.deleteResource(
      "AWS::S3::Bucket",
      "nonexistent",
    );

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.NOT_FOUND);
    expect(result).toBeNull();
  });

  it("delete no RequestToken — returns UNKNOWN error", async () => {
    mockClient.send.mockResolvedValue({ ProgressEvent: {} });

    const [err, result] = await adapter.deleteResource(
      "AWS::S3::Bucket",
      "bucket",
    );

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.UNKNOWN);
    expect(err!.message).toContain("no RequestToken");
  });
});

// ── getRequestStatus ────────────────────────────────────────────────────────

describe("getRequestStatus", () => {
  it("T7.10: success — returns parsed status", async () => {
    mockClient.send.mockResolvedValue({
      ProgressEvent: {
        OperationStatus: "SUCCESS",
        Identifier: "my-bucket",
        StatusMessage: "Created successfully",
      },
    });

    const [err, result] = await adapter.getRequestStatus("token-123");

    expect(err).toBeNull();
    expect(result).not.toBeNull();
    expect(result!.operationStatus).toBe("SUCCESS");
    expect(result!.identifier).toBe("my-bucket");
    expect(result!.statusMessage).toBe("Created successfully");
  });

  it("getRequestStatus error — returns classified error", async () => {
    mockClient.send.mockRejectedValue(
      new GeneralServiceException({
        message: "Service unavailable",
        $metadata: {},
      }),
    );

    const [err, result] = await adapter.getRequestStatus("token-bad");

    expect(err).not.toBeNull();
    expect(err!.kind).toBe(ProvisioningErrorKind.SERVICE_ERROR);
    expect(result).toBeNull();
  });

  it("getRequestStatus with undefined event fields", async () => {
    mockClient.send.mockResolvedValue({ ProgressEvent: {} });

    const [err, result] = await adapter.getRequestStatus("token-empty");

    expect(err).toBeNull();
    expect(result).not.toBeNull();
    expect(result!.operationStatus).toBeUndefined();
    expect(result!.identifier).toBeUndefined();
    expect(result!.statusMessage).toBeUndefined();
  });
});

// ── classifyError edge cases ────────────────────────────────────────────────

describe("classifyError — all error code mappings", () => {
  it("T7.11a: AccessDenied name variant", async () => {
    const accessDeniedError = new Error("Access denied");
    accessDeniedError.name = "AccessDenied";
    mockClient.send.mockRejectedValue(accessDeniedError);

    const [err] = await adapter.getResource("AWS::S3::Bucket", "test");
    expect(err!.kind).toBe(ProvisioningErrorKind.ACCESS_DENIED);
  });

  it("T7.11b: GeneralServiceException maps to SERVICE_ERROR", async () => {
    mockClient.send.mockRejectedValue(
      new GeneralServiceException({
        message: "Internal error",
        $metadata: {},
      }),
    );

    const [err] = await adapter.getResource("AWS::S3::Bucket", "test");
    expect(err!.kind).toBe(ProvisioningErrorKind.SERVICE_ERROR);
  });

  it("T7.11c: non-Error throw stringified to UNKNOWN", async () => {
    mockClient.send.mockRejectedValue("raw string error");

    const [err] = await adapter.getResource("AWS::S3::Bucket", "test");
    expect(err!.kind).toBe(ProvisioningErrorKind.UNKNOWN);
    expect(err!.message).toBe("raw string error");
  });
});
