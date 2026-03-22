/**
 * Tests for resource-resolver.ts
 *
 * @see Story 18.5
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock AWS SDK ────────────────────────────────────────────────────────────
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => {
  class MockResourceGroupsTaggingAPIClient {
    send = mockSend;
  }
  return {
    ResourceGroupsTaggingAPIClient: MockResourceGroupsTaggingAPIClient,
    GetResourcesCommand: vi.fn(),
  };
});

import { resolveResource } from "./resource-resolver.js";

// Create a mock tagging client (the constructor is mocked, so it uses mockSend)
const taggingClient = new (
  await import("@aws-sdk/client-resource-groups-tagging-api")
).ResourceGroupsTaggingAPIClient({});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveResource", () => {
  describe("ARN input", () => {
    it("resolves an S3 bucket by ARN", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [
              { Key: "managed-by", Value: "assignee-ai" },
              { Key: "environment", Value: "poc" },
            ],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "arn:aws:s3:::my-bucket",
        taggingClient,
        "us-east-1",
      );

      expect(result).not.toBeNull();
      expect(result!.arn).toBe("arn:aws:s3:::my-bucket");
      expect(result!.resourceType).toBe("AWS::S3::Bucket");
      expect(result!.identifier).toBe("my-bucket");
      expect(result!.tags["managed-by"]).toBe("assignee-ai");
    });

    it("resolves a Lambda function by ARN", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:lambda:us-east-1:123456789:function:my-func",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "arn:aws:lambda:us-east-1:123456789:function:my-func",
        taggingClient,
        "us-east-1",
      );

      expect(result).not.toBeNull();
      expect(result!.resourceType).toBe("AWS::Lambda::Function");
      expect(result!.identifier).toBe("my-func");
      expect(result!.region).toBe("us-east-1");
    });

    it("returns null for ARN not tagged as managed", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "arn:aws:s3:::unmanaged-bucket",
        taggingClient,
        "us-east-1",
      );

      expect(result).toBeNull();
    });
  });

  describe("name input", () => {
    it("resolves a resource by name", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
          {
            ResourceARN: "arn:aws:lambda:us-east-1:123:function:other-func",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "my-bucket",
        taggingClient,
        "us-east-1",
      );

      expect(result).not.toBeNull();
      expect(result!.arn).toBe("arn:aws:s3:::my-bucket");
      expect(result!.identifier).toBe("my-bucket");
    });

    it("returns null for non-existent name", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::other-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "nonexistent",
        taggingClient,
        "us-east-1",
      );

      expect(result).toBeNull();
    });

    it("handles pagination", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::bucket-1",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: "next-page",
      });
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::target-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "target-bucket",
        taggingClient,
        "us-east-1",
      );

      expect(result).not.toBeNull();
      expect(result!.arn).toBe("arn:aws:s3:::target-bucket");
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe("non-managed resources", () => {
    it("returns null when resource has no managed-by tag", async () => {
      // The tagging API query already filters by managed-by=assignee-ai,
      // so non-managed resources won't appear in results
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "unmanaged-bucket",
        taggingClient,
        "us-east-1",
      );

      expect(result).toBeNull();
    });
  });
});
