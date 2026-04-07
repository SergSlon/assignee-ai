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

  // ── SSM Parameter regression suite (P0-3 destroy resolver fix) ─────────
  describe("SSM Parameter", () => {
    // Real-shaped ARNs harvested from actual AWS responses.
    const bareArn = "arn:aws:ssm:us-east-1:112233445566:parameter/smoke-test-x";
    const nestedArn =
      "arn:aws:ssm:us-east-1:112233445566:parameter/myapp/database/host";
    const secretArn =
      "arn:aws:ssm:us-east-1:112233445566:parameter/myapp/secret-token";
    const managedTags = [{ Key: "managed-by", Value: "assignee-ai" }];

    function mockTagging(arns: string[]): void {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: arns.map((arn) => ({
          ResourceARN: arn,
          Tags: managedTags,
        })),
        PaginationToken: undefined,
      });
    }

    it("resolves bare SSM parameter name (as typed from list output)", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(
        "smoke-test-x",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.arn).toBe(bareArn);
      expect(result!.resourceType).toBe("AWS::SSM::Parameter");
      // Canonical SSM identifier has a leading slash — CloudControl requires it.
      expect(result!.identifier).toBe("/smoke-test-x");
    });

    it("resolves SSM parameter with leading slash (canonical form)", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(
        "/smoke-test-x",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.arn).toBe(bareArn);
      expect(result!.identifier).toBe("/smoke-test-x");
    });

    it("resolves nested SSM parameter path with leading slash", async () => {
      mockTagging([nestedArn]);
      const result = await resolveResource(
        "/myapp/database/host",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.arn).toBe(nestedArn);
      expect(result!.identifier).toBe("/myapp/database/host");
    });

    it("resolves nested SSM parameter path without leading slash", async () => {
      mockTagging([nestedArn]);
      const result = await resolveResource(
        "myapp/database/host",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.arn).toBe(nestedArn);
      expect(result!.identifier).toBe("/myapp/database/host");
    });

    it("resolves SSM parameter by full ARN", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(bareArn, taggingClient, "us-east-1");
      expect(result).not.toBeNull();
      expect(result!.arn).toBe(bareArn);
      expect(result!.resourceType).toBe("AWS::SSM::Parameter");
      expect(result!.identifier).toBe("/smoke-test-x");
      expect(result!.region).toBe("us-east-1");
    });

    it("resolves nested SSM parameter by full ARN", async () => {
      mockTagging([nestedArn]);
      const result = await resolveResource(
        nestedArn,
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.identifier).toBe("/myapp/database/host");
    });

    it("returns null when bare name has no matching managed resource", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(
        "not-there",
        taggingClient,
        "us-east-1",
      );
      expect(result).toBeNull();
    });

    it("returns null when slash-prefixed name does not match any resource", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(
        "/nonexistent",
        taggingClient,
        "us-east-1",
      );
      expect(result).toBeNull();
    });

    it("picks the right SSM parameter among multiple managed resources", async () => {
      mockTagging([
        "arn:aws:ssm:us-east-1:112233445566:parameter/other-param",
        bareArn,
        "arn:aws:s3:::some-bucket",
      ]);
      const result = await resolveResource(
        "smoke-test-x",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.arn).toBe(bareArn);
    });

    it("resolves SSM parameter across pagination", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN:
              "arn:aws:ssm:us-east-1:112233445566:parameter/first-page-param",
            Tags: managedTags,
          },
        ],
        PaginationToken: "next-page",
      });
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [{ ResourceARN: nestedArn, Tags: managedTags }],
        PaginationToken: undefined,
      });
      const result = await resolveResource(
        "/myapp/database/host",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.arn).toBe(nestedArn);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("SecureString variant: managed-by tag is all that matters to the resolver", async () => {
      // SecureString parameters surface with the same ARN shape. The
      // resolver does not care about Type — it keys on ARN + managed tag.
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: secretArn,
            Tags: [
              { Key: "managed-by", Value: "assignee-ai" },
              { Key: "ParameterType", Value: "SecureString" },
            ],
          },
        ],
        PaginationToken: undefined,
      });
      const result = await resolveResource(
        "/myapp/secret-token",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.arn).toBe(secretArn);
      expect(result!.identifier).toBe("/myapp/secret-token");
      expect(result!.tags["ParameterType"]).toBe("SecureString");
    });

    it("SecureString variant resolves by bare name", async () => {
      mockTagging([secretArn]);
      const result = await resolveResource(
        "myapp/secret-token",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.identifier).toBe("/myapp/secret-token");
    });

    it("StringList variant resolves by bare name", async () => {
      const stringListArn =
        "arn:aws:ssm:us-east-1:112233445566:parameter/app/feature-flags";
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: stringListArn,
            Tags: [
              { Key: "managed-by", Value: "assignee-ai" },
              { Key: "ParameterType", Value: "StringList" },
            ],
          },
        ],
        PaginationToken: undefined,
      });
      const result = await resolveResource(
        "app/feature-flags",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.identifier).toBe("/app/feature-flags");
      expect(result!.tags["ParameterType"]).toBe("StringList");
    });

    it("returns the SSM region extracted from the ARN", async () => {
      const euArn =
        "arn:aws:ssm:eu-west-1:112233445566:parameter/eu-app/config";
      mockTagging([euArn]);
      const result = await resolveResource(
        "/eu-app/config",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.region).toBe("eu-west-1");
    });

    it("does not confuse SSM parameter with an unrelated S3 bucket of the same basename", async () => {
      mockTagging([
        "arn:aws:s3:::database-host",
        "arn:aws:ssm:us-east-1:112233445566:parameter/myapp/database/host",
      ]);
      // "database/host" has a slash, so it cannot collide with the bucket name "database-host".
      const result = await resolveResource(
        "myapp/database/host",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.resourceType).toBe("AWS::SSM::Parameter");
    });

    it("does not match a slash-prefixed query against a non-SSM resource", async () => {
      // "/my-bucket" with a leading slash should not match an S3 bucket named "my-bucket".
      mockTagging(["arn:aws:s3:::my-bucket"]);
      const result = await resolveResource(
        "/my-bucket",
        taggingClient,
        "us-east-1",
      );
      expect(result).toBeNull();
    });

    it("deeply nested SSM path resolves by bare input", async () => {
      const deepArn =
        "arn:aws:ssm:us-east-1:112233445566:parameter/company/team/service/env/var";
      mockTagging([deepArn]);
      const result = await resolveResource(
        "company/team/service/env/var",
        taggingClient,
        "us-east-1",
      );
      expect(result).not.toBeNull();
      expect(result!.identifier).toBe("/company/team/service/env/var");
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
