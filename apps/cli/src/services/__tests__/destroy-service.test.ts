/**
 * Tests for destroy-service.ts — destroySingleResource()
 *
 * @see Story 36.1
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const {
  mockDeleteResource,
  mockGetRequestStatus,
  mockDeleteEventSourceMapping,
  mockUnsubscribe,
  mockDeleteTopic,
  mockCfSend,
  mockDdbSend,
} = vi.hoisted(() => ({
  mockDeleteResource: vi.fn(),
  mockGetRequestStatus: vi.fn(),
  mockDeleteEventSourceMapping: vi.fn(),
  mockUnsubscribe: vi.fn(),
  mockDeleteTopic: vi.fn(),
  mockCfSend: vi.fn(),
  mockDdbSend: vi.fn(),
}));

// ── Mock operator credentials ─────────────────────────────────────────────────
vi.mock("../../config/operator-credentials.js", () => ({
  operatorCredentials: vi.fn(() => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  })),
}));

// ── Mock CloudControlAdapter ──────────────────────────────────────────────────
vi.mock("../cloudcontrol-adapter.js", () => ({
  CloudControlAdapter: vi.fn().mockImplementation(() => ({
    deleteResource: mockDeleteResource,
    getRequestStatus: mockGetRequestStatus,
  })),
}));

// ── Mock createCloudControlClient ─────────────────────────────────────────────
vi.mock("../cloudcontrol-client.js", () => ({
  createCloudControlClient: vi.fn().mockReturnValue({}),
}));

// ── Mock SDKFallbackDispatcher ────────────────────────────────────────────────
vi.mock("../sdk-fallback-dispatcher.js", () => ({
  SDKFallbackDispatcher: vi.fn().mockImplementation(() => ({
    deleteEventSourceMapping: mockDeleteEventSourceMapping,
    unsubscribe: mockUnsubscribe,
    deleteTopic: mockDeleteTopic,
  })),
}));

// ── Mock @aws-sdk/client-cloudfront ───────────────────────────────────────────
vi.mock("@aws-sdk/client-cloudfront", () => {
  class MockCloudFrontClient {
    send = mockCfSend;
  }
  return {
    CloudFrontClient: MockCloudFrontClient,
    GetDistributionCommand: vi.fn().mockImplementation((input) => ({
      _type: "GetDistribution",
      ...input,
    })),
    UpdateDistributionCommand: vi.fn().mockImplementation((input) => ({
      _type: "UpdateDistribution",
      ...input,
    })),
    DeleteDistributionCommand: vi.fn().mockImplementation((input) => ({
      _type: "DeleteDistribution",
      ...input,
    })),
  };
});

// ── Mock @aws-sdk/client-dynamodb ─────────────────────────────────────────────
vi.mock("@aws-sdk/client-dynamodb", () => {
  class MockDynamoDBClient {
    send = mockDdbSend;
  }
  return {
    DynamoDBClient: MockDynamoDBClient,
    UpdateTableCommand: vi.fn().mockImplementation((input) => ({
      _type: "UpdateTable",
      ...input,
    })),
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────
import { destroySingleResource } from "../destroy-service.js";

// Stub global setTimeout to resolve immediately — avoids real timer waits in
// pollDeleteStatus and the CloudFront disable-then-delete polling loop.
const originalSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error — simplified stub for test purposes
  globalThis.setTimeout = (fn: () => void) => originalSetTimeout(fn, 0);
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
});
