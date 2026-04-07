/**
 * Tests for destroy-service.ts — destroySingleResource()
 *
 * @see Story 36.1
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { MissingAssigneeCredentialsError } from "@assignee/core";
import { requireAssigneeCredentials } from "../../config/aws-credentials.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const {
  mockDeleteResource,
  mockGetRequestStatus,
  mockDeleteEventSourceMapping,
  mockUnsubscribe,
  mockDeleteTopic,
  mockCfSend,
  mockDdbSend,
  mockS3Send,
} = vi.hoisted(() => ({
  mockDeleteResource: vi.fn(),
  mockGetRequestStatus: vi.fn(),
  mockDeleteEventSourceMapping: vi.fn(),
  mockUnsubscribe: vi.fn(),
  mockDeleteTopic: vi.fn(),
  mockCfSend: vi.fn(),
  mockDdbSend: vi.fn(),
  mockS3Send: vi.fn(),
}));

// NOTE: Plain functions/classes (not vi.fn) so impls survive vitest's
// mockReset:true between tests.

// ── Mock operator credentials ─────────────────────────────────────────────────
vi.mock("../../config/operator-credentials.js", () => ({
  operatorCredentials: () => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  }),
}));

// ── Mock CloudControlAdapter ──────────────────────────────────────────────────
vi.mock("../cloudcontrol-adapter.js", () => {
  class CloudControlAdapter {
    deleteResource = mockDeleteResource;
    getRequestStatus = mockGetRequestStatus;
  }
  return { CloudControlAdapter };
});

// ── Mock createCloudControlClient ─────────────────────────────────────────────
vi.mock("../cloudcontrol-client.js", () => ({
  createCloudControlClient: () => ({}),
}));

// ── Mock SDKFallbackDispatcher ────────────────────────────────────────────────
vi.mock("../sdk-fallback-dispatcher.js", () => {
  class SDKFallbackDispatcher {
    deleteEventSourceMapping = mockDeleteEventSourceMapping;
    unsubscribe = mockUnsubscribe;
    deleteTopic = mockDeleteTopic;
  }
  return { SDKFallbackDispatcher };
});

// ── Mock @aws-sdk/client-cloudfront ───────────────────────────────────────────
vi.mock("@aws-sdk/client-cloudfront", () => {
  class MockCloudFrontClient {
    send = mockCfSend;
  }
  function GetDistributionCommand(input: Record<string, unknown>) {
    return { _type: "GetDistribution", ...input };
  }
  function UpdateDistributionCommand(input: Record<string, unknown>) {
    return { _type: "UpdateDistribution", ...input };
  }
  function DeleteDistributionCommand(input: Record<string, unknown>) {
    return { _type: "DeleteDistribution", ...input };
  }
  return {
    CloudFrontClient: MockCloudFrontClient,
    GetDistributionCommand,
    UpdateDistributionCommand,
    DeleteDistributionCommand,
  };
});

// ── Mock @aws-sdk/client-dynamodb ─────────────────────────────────────────────
vi.mock("@aws-sdk/client-dynamodb", () => {
  class MockDynamoDBClient {
    send = mockDdbSend;
  }
  function UpdateTableCommand(input: Record<string, unknown>) {
    return { _type: "UpdateTable", ...input };
  }
  function DescribeTableCommand(input: Record<string, unknown>) {
    return { _type: "DescribeTable", ...input };
  }
  return {
    DynamoDBClient: MockDynamoDBClient,
    UpdateTableCommand,
    DescribeTableCommand,
  };
});

// ── Mock @aws-sdk/client-s3 ───────────────────────────────────────────────────
vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    send = mockS3Send;
  }
  function ListObjectVersionsCommand(input: Record<string, unknown>) {
    return { _type: "ListObjectVersions", ...input };
  }
  function DeleteObjectsCommand(input: Record<string, unknown>) {
    return { _type: "DeleteObjects", ...input };
  }
  return {
    S3Client: MockS3Client,
    ListObjectVersionsCommand,
    DeleteObjectsCommand,
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────
import { destroySingleResource } from "../destroy-service.js";

// Stub global setTimeout to resolve immediately — avoids real timer waits in
// pollDeleteStatus and the CloudFront disable-then-delete polling loop.
const originalSetTimeout = globalThis.setTimeout;
const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error — simplified stub for test purposes
  globalThis.setTimeout = (fn: () => void) => originalSetTimeout(fn, 0);
  // destroy-service now uses requireAssigneeCredentials("operator") for the
  // DynamoDB and S3 pre-delete hooks. Provide realistic-shaped credentials
  // so the hooks construct their SDK clients and exercise the mocked send().
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});
afterAll(() => {
  globalThis.setTimeout = originalSetTimeout;
});

describe("destroySingleResource", () => {
  // ── CloudControl happy path ───────────────────────────────────────────────
  describe("CloudControl API path", () => {
    it("returns success when delete + poll returns SUCCESS", async () => {
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-123" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::test-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(result.resourceType).toBe("AWS::S3::Bucket");
      expect(result.identifier).toBe("test-bucket");
      expect(mockDeleteResource).toHaveBeenCalledWith(
        "AWS::S3::Bucket",
        "test-bucket",
      );
    });

    it("returns failure when poll times out (MAX_POLL_ATTEMPTS)", async () => {
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-timeout" },
      ]);
      // Always return IN_PROGRESS — with setTimeout stubbed to 0ms,
      // all 60 poll iterations complete instantly.
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "IN_PROGRESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::timeout-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "timeout-bucket",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
      // Verify all 60 poll attempts were made
      expect(mockGetRequestStatus).toHaveBeenCalledTimes(60);
    });

    it("returns failure when poll returns FAILED status", async () => {
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-fail" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        {
          operationStatus: "FAILED",
          statusMessage: "BucketNotEmpty",
        },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::fail-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "fail-bucket",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("BucketNotEmpty");
    });

    it("returns failure when deleteResource returns error", async () => {
      mockDeleteResource.mockResolvedValue([
        { kind: "NOT_FOUND", message: "Resource not found" },
        null,
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::missing-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "missing-bucket",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Resource not found");
    });
  });

  // ── SDK fallback: Lambda EventSourceMapping ───────────────────────────────
  describe("SDK fallback — Lambda EventSourceMapping", () => {
    it("returns success on successful deletion", async () => {
      mockDeleteEventSourceMapping.mockResolvedValue([null, {}]);

      const result = await destroySingleResource({
        arn: "arn:aws:lambda:us-east-1:123456:event-source-mapping:uuid-123",
        resourceType: "AWS::Lambda::EventSourceMapping",
        identifier: "uuid-123",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(mockDeleteEventSourceMapping).toHaveBeenCalledWith("uuid-123");
    });

    it("returns failure when SDK call fails", async () => {
      mockDeleteEventSourceMapping.mockResolvedValue([
        { kind: "UNKNOWN", message: "Mapping not found" },
        null,
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:lambda:us-east-1:123456:event-source-mapping:uuid-bad",
        resourceType: "AWS::Lambda::EventSourceMapping",
        identifier: "uuid-bad",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Mapping not found");
    });
  });

  // ── SDK fallback: SNS Subscription ────────────────────────────────────────
  describe("SDK fallback — SNS Subscription", () => {
    it("returns success on successful unsubscribe", async () => {
      mockUnsubscribe.mockResolvedValue([null, {}]);

      const result = await destroySingleResource({
        arn: "arn:aws:sns:us-east-1:123456:my-topic:sub-id",
        resourceType: "AWS::SNS::Subscription",
        identifier: "sub-id",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(mockUnsubscribe).toHaveBeenCalledWith(
        "arn:aws:sns:us-east-1:123456:my-topic:sub-id",
      );
    });
  });

  // ── SDK fallback: SNS Topic ───────────────────────────────────────────────
  describe("SDK fallback — SNS Topic", () => {
    it("returns success on successful topic deletion", async () => {
      mockDeleteTopic.mockResolvedValue([null, {}]);

      const result = await destroySingleResource({
        arn: "arn:aws:sns:us-east-1:123456:my-topic",
        resourceType: "AWS::SNS::Topic",
        identifier: "my-topic",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(mockDeleteTopic).toHaveBeenCalledWith(
        "arn:aws:sns:us-east-1:123456:my-topic",
      );
    });
  });

  // ── Redirect types ────────────────────────────────────────────────────────
  describe("Redirect types", () => {
    it("returns error for Lambda::Permission (redirect type)", async () => {
      const result = await destroySingleResource({
        arn: "arn:aws:lambda:us-east-1:123456:policy:my-policy",
        resourceType: "AWS::Lambda::Permission",
        identifier: "my-policy",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be deleted");
      expect(result.error).toContain("manual deletion");
      // Should NOT call any delete method
      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(mockDeleteEventSourceMapping).not.toHaveBeenCalled();
    });
  });

  // ── DynamoDB pre-delete hook ──────────────────────────────────────────────
  describe("DynamoDB pre-delete hook", () => {
    it("disables deletion protection before deleting", async () => {
      mockDdbSend.mockResolvedValue({});
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-ddb" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456:table/my-table",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "my-table",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // DynamoDB UpdateTable should have been called to disable protection
      expect(mockDdbSend).toHaveBeenCalled();
      const updateCall = mockDdbSend.mock.calls[0]![0];
      expect(updateCall.TableName).toBe("my-table");
      expect(updateCall.DeletionProtectionEnabled).toBe(false);
    });

    it("continues to delete even if disabling protection fails", async () => {
      mockDdbSend.mockRejectedValue(new Error("Table not found"));
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-ddb2" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456:table/my-table",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "my-table",
        region: "us-east-1",
      });

      // Should still succeed — protection disable is non-fatal
      expect(result.success).toBe(true);
    });
  });

  // ── CloudFront distribution destroy ───────────────────────────────────────
  describe("CloudFront distribution destroy", () => {
    it("disables distribution, waits for deploy, then deletes", async () => {
      // GetDistribution — initial (Enabled=true)
      mockCfSend.mockResolvedValueOnce({
        Distribution: {
          DistributionConfig: { Enabled: true },
          Status: "Deployed",
        },
        ETag: "etag-1",
      });
      // UpdateDistribution — disable
      mockCfSend.mockResolvedValueOnce({});
      // GetDistribution — poll for "Deployed" status after disable
      mockCfSend.mockResolvedValueOnce({
        Distribution: { Status: "Deployed" },
        ETag: "etag-2",
      });
      // DeleteDistribution
      mockCfSend.mockResolvedValueOnce({});

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // 4 calls: get, update, poll-get, delete
      expect(mockCfSend).toHaveBeenCalledTimes(4);
    });

    it("deletes directly when already disabled", async () => {
      // GetDistribution — already disabled
      mockCfSend.mockResolvedValueOnce({
        Distribution: {
          DistributionConfig: { Enabled: false },
          Status: "Deployed",
        },
        ETag: "etag-disabled",
      });
      // DeleteDistribution
      mockCfSend.mockResolvedValueOnce({});

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // 2 calls: get, delete
      expect(mockCfSend).toHaveBeenCalledTimes(2);
    });

    it("returns error when distribution config cannot be retrieved", async () => {
      mockCfSend.mockResolvedValueOnce({
        Distribution: null,
        ETag: null,
      });

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not retrieve distribution config");
    });

    it("returns error when CloudFront SDK throws", async () => {
      mockCfSend.mockRejectedValueOnce(new Error("AccessDenied"));

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("CloudFront destroy failed");
    });

    // L-A12 regression: the CloudFront branch must use the same
    // requireAssigneeCredentials("operator") helper as the rest of
    // destroy-service. Previously it inspected awsConfig.accessKeyId from
    // operatorCredentials() and emitted a generic "Missing AWS credentials"
    // error, drifting from the central helper that names the exact env vars.
    it("surfaces requireAssigneeCredentials error when ASSIGNEE_OPERATOR vars are unset", async () => {
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      // The friendly error must name the same env vars as the central
      // helper, NOT the legacy "Missing AWS credentials for resource cleanup"
      // string with no actionable detail.
      expect(result.error).toContain("Missing AWS credentials");
      expect(result.error).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
      // No CloudFront SDK calls must have been issued — the credential
      // check fires BEFORE the first cf.send().
      expect(mockCfSend).not.toHaveBeenCalled();
    });
  });

  // ── Missing credentials ───────────────────────────────────────────────────
  describe("Missing credentials", () => {
    it("returns error when CloudControl adapter throws", async () => {
      mockDeleteResource.mockRejectedValue(
        new Error("Missing credentials in config"),
      );

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::cred-fail",
        resourceType: "AWS::S3::Bucket",
        identifier: "cred-fail",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing credentials");
    });
  });

  // ── Fail-closed credential enforcement for pre-delete hooks ───────────────
  // When ASSIGNEE_OPERATOR_* env vars are missing, the DynamoDB and S3
  // pre-delete hooks must NOT call the AWS SDK and MUST surface the
  // credential error as a clean DestroyResult.error rather than silently
  // swallowing it (which would cause CloudControl DeleteResource to fail
  // later with a confusing ResourceInUseException / BucketNotEmpty error).
  describe("fail-closed pre-delete hooks (missing ASSIGNEE_OPERATOR_*)", () => {
    beforeEach(() => {
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
      // Belt-and-suspenders: shell AWS_* must NOT be honored
      process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";
    });

    it("DynamoDB hook surfaces MissingAssigneeCredentialsError instead of silently skipping", async () => {
      // The main CloudControl path must NOT be called — we fail early with
      // a clear credential error.
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "orders",
        region: "us-east-1",
      });

      // Critical: no AWS SDK call happened — we did NOT leak to
      // ~/.aws/credentials despite shell AWS_* vars being set.
      expect(mockDdbSend).not.toHaveBeenCalled();
      // Critical: we also short-circuit the CloudControl delete so the user
      // sees the credential error, not a confusing ResourceInUseException.
      expect(mockDeleteResource).not.toHaveBeenCalled();
      // The error is surfaced as a clean DestroyResult rather than thrown.
      expect(result.success).toBe(false);
      expect(result.error).toContain("DynamoDB deletion protection");
      expect(result.error).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
    });

    it("S3 hook surfaces MissingAssigneeCredentialsError instead of silently skipping", async () => {
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::production-assets",
        resourceType: "AWS::S3::Bucket",
        identifier: "production-assets",
        region: "us-east-1",
      });

      // Must short-circuit: do not proceed to CloudControl delete with an
      // un-emptied bucket. The user must see the credential error, not a
      // downstream BucketNotEmpty error.
      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain("empty S3 bucket");
      expect(result.error).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
    });

    it("MissingAssigneeCredentialsError names the operator env vars", () => {
      // Direct contract test of the helper used by the hooks.
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

  // ── CloudFront disable polling — H20 ─────────────────────────────────────
  // The CloudFront disable-wait loop must tolerate transient errors from
  // GetDistribution (throttling, 5xx) and retry them rather than aborting
  // the entire destroy on the first failure. Previously a single throw
  // aborted the disable/delete with no retry.
  describe("CloudFront disable polling resilience", () => {
    it("retries transient GetDistribution errors during the disable wait", async () => {
      // Step 1: GetDistribution (initial) — Enabled=true
      mockCfSend.mockResolvedValueOnce({
        Distribution: {
          DistributionConfig: { Enabled: true },
          Status: "InProgress",
        },
        ETag: "etag-1",
      });
      // Step 2: UpdateDistribution — disable ok
      mockCfSend.mockResolvedValueOnce({});
      // Step 3: Polling GetDistribution — first 2 calls throw transient
      // errors, third call returns Deployed.
      mockCfSend.mockRejectedValueOnce(new Error("ThrottlingException"));
      mockCfSend.mockRejectedValueOnce(new Error("503 ServiceUnavailable"));
      mockCfSend.mockResolvedValueOnce({
        Distribution: { Status: "Deployed" },
        ETag: "etag-2",
      });
      // Step 4: DeleteDistribution — final
      mockCfSend.mockResolvedValueOnce({});

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // 6 calls: get, update, 2x transient poll, successful poll, delete
      expect(mockCfSend).toHaveBeenCalledTimes(6);
    });

    it("aborts cleanly after too many consecutive transient poll errors", async () => {
      // Step 1: GetDistribution — Enabled=true
      mockCfSend.mockResolvedValueOnce({
        Distribution: {
          DistributionConfig: { Enabled: true },
          Status: "InProgress",
        },
        ETag: "etag-1",
      });
      // Step 2: UpdateDistribution — disable ok
      mockCfSend.mockResolvedValueOnce({});
      // All subsequent polls throw transient errors until the retry budget
      // (CLOUDFRONT_MAX_TRANSIENT_ERRORS = 5 consecutive) is exhausted.
      mockCfSend.mockRejectedValue(new Error("Throttling"));

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("CloudFront poll failed");
      expect(result.error).toContain("Throttling");
    });
  });

  // ── M-R1: DynamoDB UpdateTable race vs delete ─────────────────────────────
  // UpdateTable(DeletionProtectionEnabled: false) returns immediately while
  // the disable propagates asynchronously. Without polling, the subsequent
  // CloudControl DeleteResource call races and fails with
  // ResourceInUseException. Verify we poll DescribeTable until the change is
  // visible BEFORE running the CloudControl delete.
  describe("DynamoDB pre-delete protection propagation (M-R1)", () => {
    it("polls DescribeTable until DeletionProtectionEnabled is false before deleting", async () => {
      // 1) UpdateTable — succeeds (returns no protection field)
      mockDdbSend.mockResolvedValueOnce({});
      // 2) DescribeTable — first poll: still propagating (true)
      mockDdbSend.mockResolvedValueOnce({
        Table: {
          TableName: "orders",
          DeletionProtectionEnabled: true,
        },
      });
      // 3) DescribeTable — second poll: still true
      mockDdbSend.mockResolvedValueOnce({
        Table: {
          TableName: "orders",
          DeletionProtectionEnabled: true,
        },
      });
      // 4) DescribeTable — third poll: now false, exit loop
      mockDdbSend.mockResolvedValueOnce({
        Table: {
          TableName: "orders",
          DeletionProtectionEnabled: false,
        },
      });

      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-mr1" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "orders",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // Exactly 4 ddb calls: 1 UpdateTable + 3 DescribeTable polls.
      expect(mockDdbSend).toHaveBeenCalledTimes(4);
      const updateCall = mockDdbSend.mock.calls[0]![0];
      expect(updateCall._type).toBe("UpdateTable");
      expect(updateCall.DeletionProtectionEnabled).toBe(false);
      // All subsequent calls must be DescribeTable for the same table.
      for (let i = 1; i <= 3; i++) {
        const call = mockDdbSend.mock.calls[i]![0];
        expect(call._type).toBe("DescribeTable");
        expect(call.TableName).toBe("orders");
      }
      // CloudControl delete must run AFTER the polling exits — never racing
      // an in-flight protection disable.
      expect(mockDeleteResource).toHaveBeenCalledTimes(1);
    });

    it("gives up cleanly after the propagation poll budget is exhausted", async () => {
      // UpdateTable — ok
      mockDdbSend.mockResolvedValueOnce({});
      // All subsequent polls report still-protected. The implementation
      // is bounded to DDB_DISABLE_PROTECTION_MAX_POLLS=6 polls before
      // moving on to the CloudControl delete (which will surface its own
      // error if the table is genuinely still protected).
      mockDdbSend.mockResolvedValue({
        Table: {
          TableName: "orders",
          DeletionProtectionEnabled: true,
        },
      });

      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-bdg" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "orders",
        region: "us-east-1",
      });

      // 1 UpdateTable + 6 DescribeTable polls = 7 total ddb calls.
      expect(mockDdbSend).toHaveBeenCalledTimes(7);
      // Delete still proceeds (CloudControl will surface a clean error if
      // the table is truly protected) — the test result therefore reflects
      // the SUCCESS we mocked from CloudControl.
      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalledTimes(1);
    });
  });

  // ── M-R2: S3 DeleteObjects 1000-key chunking ─────────────────────────────
  // ListObjectVersions can return up to 1000 Versions PLUS up to 1000
  // DeleteMarkers per page (2000 combined). DeleteObjects accepts at most
  // 1000 keys per request, so the merged array MUST be chunked.
  describe("S3 pre-delete object chunking (M-R2)", () => {
    it("splits 1500 mixed Versions+DeleteMarkers into exactly 2 DeleteObjects calls", async () => {
      // Realistic shape: 900 Versions + 600 DeleteMarkers = 1500 total
      const Versions = Array.from({ length: 900 }, (_, i) => ({
        Key: `logs/2026/03/event-${i.toString().padStart(4, "0")}.json`,
        VersionId: `v${i.toString().padStart(8, "0")}`,
      }));
      const DeleteMarkers = Array.from({ length: 600 }, (_, i) => ({
        Key: `logs/2026/03/event-deleted-${i.toString().padStart(4, "0")}.json`,
        VersionId: `dm${i.toString().padStart(7, "0")}`,
      }));

      // ListObjectVersions — single page (IsTruncated false)
      mockS3Send.mockResolvedValueOnce({
        Versions,
        DeleteMarkers,
        IsTruncated: false,
      });
      // DeleteObjects — first chunk (1000 keys)
      mockS3Send.mockResolvedValueOnce({});
      // DeleteObjects — second chunk (500 keys)
      mockS3Send.mockResolvedValueOnce({});

      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-s3c" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::production-logs",
        resourceType: "AWS::S3::Bucket",
        identifier: "production-logs",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);

      // Calls: 1 ListObjectVersions + 2 DeleteObjects (chunked) = 3.
      expect(mockS3Send).toHaveBeenCalledTimes(3);

      const listCall = mockS3Send.mock.calls[0]![0];
      expect(listCall._type).toBe("ListObjectVersions");

      const firstDelete = mockS3Send.mock.calls[1]![0];
      expect(firstDelete._type).toBe("DeleteObjects");
      expect(firstDelete.Delete.Objects).toHaveLength(1000);

      const secondDelete = mockS3Send.mock.calls[2]![0];
      expect(secondDelete._type).toBe("DeleteObjects");
      expect(secondDelete.Delete.Objects).toHaveLength(500);

      // Sanity: every key in the chunks comes from the original lists, no
      // duplication or loss.
      const allKeys = [
        ...firstDelete.Delete.Objects.map((o: { Key: string }) => o.Key),
        ...secondDelete.Delete.Objects.map((o: { Key: string }) => o.Key),
      ];
      expect(allKeys).toHaveLength(1500);
      expect(new Set(allKeys).size).toBe(1500);
    });
  });
});
