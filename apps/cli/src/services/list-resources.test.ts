/**
 * Tests for the list-resources service.
 *
 * @see Story 18.4
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AWS SDK.
// NOTE: Constructor implementations are re-installed in beforeEach because
// vitest's mockReset:true wipes vi.fn implementations between tests.
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => ({
  ResourceGroupsTaggingAPIClient: vi.fn(),
  GetResourcesCommand: vi.fn(),
}));

// Mock node:fs for provision log reads
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

// Mock constants
vi.mock("../config/constants.js", () => ({
  ASSIGNEE_DIR: ".assignee",
  AWS_REGION: "us-east-1",
  AWS_SERVICE_EXECUTE_API: "execute-api",
  PROVISIONS_FILE: "provisions.json",
  UNKNOWN_FALLBACK: "unknown",
}));

vi.mock("../utils/tags.js", () => ({
  TAG_KEY_MANAGED_BY: "managed-by",
  TAG_VALUE_MANAGED_BY: "assignee-ai",
}));

import * as fs from "node:fs";
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from "@aws-sdk/client-resource-groups-tagging-api";
import {
  fetchManagedResources,
  parseArn,
  arnToCloudFormationType,
} from "./list-resources.js";

describe("list-resources service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-install mock impls (mockReset wipes them between tests).
    (
      ResourceGroupsTaggingAPIClient as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => ({ send: mockSend }));
    (
      GetResourcesCommand as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((input: unknown) => input);
    // Default: no provision log
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  describe("fetchManagedResources", () => {
    it("returns parsed resources from GetResources response", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [
              { Key: "managed-by", Value: "assignee-ai" },
              { Key: "assignee-run-id", Value: "run-123" },
            ],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await fetchManagedResources();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        resourceType: "AWS::S3::Bucket",
        arn: "arn:aws:s3:::my-bucket",
        region: "us-east-1",
        createdDate: "N/A",
        estimatedMonthlyCost: "N/A",
      });
    });

    it("handles pagination (multiple pages)", async () => {
      mockSend
        .mockResolvedValueOnce({
          ResourceTagMappingList: [
            {
              ResourceARN: "arn:aws:s3:::bucket-1",
              Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
            },
          ],
          PaginationToken: "token-page-2",
        })
        .mockResolvedValueOnce({
          ResourceTagMappingList: [
            {
              ResourceARN: "arn:aws:lambda:us-east-1:123456789:function:my-fn",
              Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
            },
          ],
          PaginationToken: undefined,
        });

      const result = await fetchManagedResources();

      expect(result).toHaveLength(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(result[0]!.arn).toBe("arn:aws:s3:::bucket-1");
      expect(result[1]!.arn).toBe(
        "arn:aws:lambda:us-east-1:123456789:function:my-fn",
      );
    });

    it("returns empty array when no resources found", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [],
        PaginationToken: undefined,
      });

      const result = await fetchManagedResources();

      expect(result).toEqual([]);
    });

    it("region parameter is passed to client constructor", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [],
        PaginationToken: undefined,
      });

      await fetchManagedResources("eu-west-1");

      expect(ResourceGroupsTaggingAPIClient).toHaveBeenCalledWith({
        region: "eu-west-1",
      });
    });

    it("uses default region when none specified", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [],
        PaginationToken: undefined,
      });

      await fetchManagedResources();

      expect(ResourceGroupsTaggingAPIClient).toHaveBeenCalledWith({
        region: "us-east-1",
      });
    });

    it("provision log cost lookup works", async () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce(
        JSON.stringify([
          {
            resourceArn: "arn:aws:s3:::my-bucket",
            estimatedMonthlyCost: "$0.023/GB",
          },
        ]),
      );

      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await fetchManagedResources();

      expect(result[0]!.estimatedMonthlyCost).toBe("$0.023/GB");
    });

    it("missing provision log file returns N/A for cost", async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await fetchManagedResources();

      expect(result[0]!.estimatedMonthlyCost).toBe("N/A");
    });

    it("shows N/A for created date when no assignee-run-id tag", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await fetchManagedResources();

      expect(result[0]!.createdDate).toBe("N/A");
    });
  });

  describe("parseArn", () => {
    it("extracts service, region, and resource type from S3 ARN", () => {
      const result = parseArn("arn:aws:s3:::my-bucket");
      expect(result.service).toBe("s3");
      expect(result.resourceType).toBe("AWS::S3::Bucket");
    });

    it("extracts region from Lambda ARN", () => {
      const result = parseArn(
        "arn:aws:lambda:us-west-2:123456789:function:my-fn",
      );
      expect(result.service).toBe("lambda");
      expect(result.region).toBe("us-west-2");
      expect(result.resourceType).toBe("AWS::Lambda::Function");
    });

    it("extracts EC2 instance type", () => {
      const result = parseArn(
        "arn:aws:ec2:us-east-1:123456789:instance/i-1234567890abcdef0",
      );
      expect(result.service).toBe("ec2");
      expect(result.resourceType).toBe("AWS::EC2::Instance");
    });

    it("extracts RDS type", () => {
      const result = parseArn("arn:aws:rds:us-east-1:123456789:db:my-database");
      expect(result.service).toBe("rds");
      expect(result.resourceType).toBe("AWS::RDS::DBInstance");
    });
  });

  describe("arnToCloudFormationType", () => {
    it("maps known services correctly", () => {
      expect(arnToCloudFormationType("s3", "")).toBe("AWS::S3::Bucket");
      expect(arnToCloudFormationType("lambda", "function:my-fn")).toBe(
        "AWS::Lambda::Function",
      );
      expect(arnToCloudFormationType("ec2", "instance/i-123")).toBe(
        "AWS::EC2::Instance",
      );
      expect(arnToCloudFormationType("rds", "db:my-db")).toBe(
        "AWS::RDS::DBInstance",
      );
    });

    it("falls back to capitalized service name for unknown services", () => {
      const result = arnToCloudFormationType("customservice", "myresource");
      expect(result).toBe("AWS::Customservice::Myresource");
    });
  });
});
