/**
 * Unit tests for list_managed_resources MCP tool.
 *
 * @see Story 20.4
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// NOTE: We use a vi.fn constructor (so tests can assert it was called with
// region args) and re-install its implementation in beforeEach, because
// vitest's mockReset:true wipes vi.fn implementations between tests. The
// hoisted mockSend keeps stable identity across tests.
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => ({
  ResourceGroupsTaggingAPIClient: vi.fn(),
  GetResourcesCommand: vi.fn(),
}));

// Mock fs for provision log reading. Default impl is re-installed in
// beforeEach because mockReset wipes it.
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import * as fs from "node:fs";
import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { fetchManagedResources } from "../services/list-resources.js";

// Access the mock send function
const getMockSend = () => mockSend;

// Top-level beforeEach so constructor impl is re-installed for every describe
// block (mockReset:true wipes it between tests).
beforeEach(() => {
  vi.mocked(ResourceGroupsTaggingAPIClient).mockImplementation(
    () =>
      ({
        send: mockSend,
        destroy: vi.fn(),
      }) as unknown as ResourceGroupsTaggingAPIClient,
  );
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw new Error("File not found");
  });
  // Story 49-HIGH-1: list-resources now requires ASSIGNEE_OPERATOR_*.
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

describe("list_managed_resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return an array of managed resources with correct shape", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::my-bucket-12345",
          Tags: [
            { Key: "managed-by", Value: "assignee-ai" },
            { Key: "assignee-run-id", Value: "2026-03-15T10:30:00Z" },
          ],
        },
        {
          ResourceARN:
            "arn:aws:lambda:us-east-1:123456789012:function:my-function",
          Tags: [
            { Key: "managed-by", Value: "assignee-ai" },
            { Key: "assignee-run-id", Value: "2026-03-16T11:00:00Z" },
          ],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");

    expect(resources).toHaveLength(2);
    expect(resources[0]).toEqual({
      resourceType: "AWS::S3::Bucket",
      arn: "arn:aws:s3:::my-bucket-12345",
      region: "us-east-1",
      createdDate: "2026-03-15T10:30:00Z",
      estimatedMonthlyCost: "N/A",
    });
    expect(resources[1]).toEqual({
      resourceType: "AWS::Lambda::Function",
      arn: "arn:aws:lambda:us-east-1:123456789012:function:my-function",
      region: "us-east-1",
      createdDate: "2026-03-16T11:00:00Z",
      estimatedMonthlyCost: "N/A",
    });
  });

  it("should return empty array when no tagged resources exist", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");

    expect(resources).toEqual([]);
  });

  it("should return structured error on AWS credentials failure", async () => {
    const mockSend = getMockSend();
    mockSend.mockRejectedValueOnce(new Error("Missing credentials in config"));

    await expect(fetchManagedResources("us-east-1")).rejects.toThrow(
      "Missing credentials in config",
    );
  });

  it("should forward region parameter to AWS client", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });

    await fetchManagedResources("eu-west-1");

    // Story 49-HIGH-1: region is passed along with explicit credentials so
    // the client never falls through to the default AWS chain.
    expect(ResourceGroupsTaggingAPIClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "eu-west-1",
        credentials: expect.objectContaining({
          accessKeyId: expect.stringMatching(/^AKIA/),
        }),
      }),
    );
  });

  it("should filter resources by resourceType when specified", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::bucket-1",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
        {
          ResourceARN: "arn:aws:lambda:us-east-1:123456789012:function:fn-1",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources(
      "us-east-1",
      "AWS::S3::Bucket",
    );

    expect(resources).toHaveLength(1);
    expect(resources[0]!.resourceType).toBe("AWS::S3::Bucket");
  });

  it("should handle paginated responses", async () => {
    const mockSend = getMockSend();
    mockSend
      .mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::bucket-1",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: "next-page-token",
      })
      .mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::bucket-2",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

    const resources = await fetchManagedResources("us-east-1");

    expect(resources).toHaveLength(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("should use default region when none specified", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });

    await fetchManagedResources();

    // Should have been called with some region (the default)
    expect(ResourceGroupsTaggingAPIClient).toHaveBeenCalled();
  });
});

// ── Tagging API error scenarios ──────────────────────────────────────────────

describe("list_managed_resources — Tagging API errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should propagate ThrottlingException from Tagging API", async () => {
    const mockSend = getMockSend();
    const throttleError = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 429 },
    });
    mockSend.mockRejectedValueOnce(throttleError);

    await expect(fetchManagedResources("us-east-1")).rejects.toThrow(
      "Rate exceeded",
    );
  });

  it("should propagate InternalServiceException from Tagging API", async () => {
    const mockSend = getMockSend();
    const internalError = Object.assign(new Error("Internal service error"), {
      name: "InternalServiceException",
      $metadata: { httpStatusCode: 500 },
    });
    mockSend.mockRejectedValueOnce(internalError);

    await expect(fetchManagedResources("us-east-1")).rejects.toThrow(
      "Internal service error",
    );
  });

  it("should propagate InvalidParameterException from Tagging API", async () => {
    const mockSend = getMockSend();
    const paramError = Object.assign(
      new Error("Invalid parameter: TagFilters"),
      {
        name: "InvalidParameterException",
        $metadata: { httpStatusCode: 400 },
      },
    );
    mockSend.mockRejectedValueOnce(paramError);

    await expect(fetchManagedResources("us-east-1")).rejects.toThrow(
      "Invalid parameter: TagFilters",
    );
  });
});

// ── SERVICE_SUBTYPE_MAP resolution ──────────────────────────────────────────

describe("list_managed_resources — SERVICE_SUBTYPE_MAP resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should resolve EC2 instance ARN via subtype map", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.resourceType).toBe("AWS::EC2::Instance");
  });

  it("should resolve EC2 VPC ARN via subtype map", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0abc",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.resourceType).toBe("AWS::EC2::VPC");
  });

  it("should resolve EC2 security-group ARN via subtype map", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN:
            "arn:aws:ec2:us-east-1:123456789012:security-group/sg-0abc",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.resourceType).toBe("AWS::EC2::SecurityGroup");
  });

  it("should resolve apigateway /apis ARN via prefixed subtype", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:apigateway:us-east-1::/apis/abc123",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.resourceType).toBe("AWS::ApiGatewayV2::Api");
  });

  it("should resolve execute-api ARN via empty-string subtype fallback", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:execute-api:us-east-1:123456789012:abc123",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.resourceType).toBe("AWS::ApiGatewayV2::Api");
  });

  it("should resolve ELBv2 loadbalancer ARN via subtype map", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN:
            "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-lb/abc",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.resourceType).toBe(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
  });

  it("should resolve ELBv2 targetgroup ARN via subtype map", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN:
            "arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/my-tg/abc",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.resourceType).toBe(
      "AWS::ElasticLoadBalancingV2::TargetGroup",
    );
  });

  it("should use fallback type construction for unknown service", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:newservice:us-east-1:123456789012:widget/w-123",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    // Fallback: AWS::<Capitalized service>::<Capitalized resource>
    expect(resources[0]!.resourceType).toBe("AWS::Newservice::Widget");
  });
});

// ── Provision log integration ────────────────────────────────────────────────

describe("list_managed_resources — provision log cost enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should enrich resources with cost data from provision log", async () => {
    // Override the fs mock to return valid provision log data
    const fsMod = await import("node:fs");
    (fsMod.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      JSON.stringify([
        {
          resourceArn: "arn:aws:s3:::cost-bucket",
          estimatedMonthlyCost: "$1.50",
        },
      ]),
    );

    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::cost-bucket",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.estimatedMonthlyCost).toBe("$1.50");
  });

  it("should show N/A cost when provision log entry lacks cost data", async () => {
    const fsMod = await import("node:fs");
    (fsMod.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      JSON.stringify([
        {
          resourceArn: "arn:aws:s3:::no-cost-bucket",
          // no estimatedMonthlyCost
        },
      ]),
    );

    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::no-cost-bucket",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.estimatedMonthlyCost).toBe("N/A");
  });

  it("should handle provision log that is not an array", async () => {
    const fsMod = await import("node:fs");
    (fsMod.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      JSON.stringify({ not: "an array" }),
    );

    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::some-bucket",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.estimatedMonthlyCost).toBe("N/A");
  });
});

// ── Edge cases: empty/null tag mappings ──────────────────────────────────────

describe("list_managed_resources — tag edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle null ResourceTagMappingList", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: undefined,
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources).toEqual([]);
  });

  it("should handle resource with empty ResourceARN", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources).toHaveLength(1);
    // The empty ARN still gets processed
    expect(resources[0]!.arn).toBe("");
  });

  it("should handle resource with no assignee-run-id tag (createdDate N/A)", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::no-run-id-bucket",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.createdDate).toBe("N/A");
  });

  it("should handle resource with no Tags array at all", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::no-tags-bucket",
          // no Tags field
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("us-east-1");
    expect(resources[0]!.createdDate).toBe("N/A");
  });

  it("should use resolvedRegion when ARN has empty region field", async () => {
    const mockSend = getMockSend();
    // S3 ARNs have empty region: arn:aws:s3:::bucket-name
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::global-bucket",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources("eu-west-1");
    expect(resources[0]!.region).toBe("eu-west-1");
  });

  it("should return empty array when resourceType filter matches nothing", async () => {
    const mockSend = getMockSend();
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::bucket-1",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const resources = await fetchManagedResources(
      "us-east-1",
      "AWS::RDS::DBInstance",
    );
    expect(resources).toEqual([]);
  });
});
