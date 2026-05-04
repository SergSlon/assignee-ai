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

// Mock IAM SDK for enumerateMcpIamRoles (ListRoles + ListRoleTags) tests.
const mockIamSend = vi.fn();
const mockIamDestroy = vi.fn();
vi.mock("@aws-sdk/client-iam", () => ({
  IAMClient: vi.fn(),
  ListRolesCommand: vi.fn(),
  ListRoleTagsCommand: vi.fn(),
}));

// Mock fs for provision log reading. Default impl is re-installed in
// beforeEach because mockReset wipes it.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

// e98.W1.B1: `fetchManagedResources` now reads the provision log for
// non-taggable constructs (Route/SRTA/VPCGatewayAttachment) via the
// async `readProvisions` path. Mock the MemoryService's underlying
// fs/promises readFile to return "file not found" so the non-taggable
// merge sees an empty provision log. Individual tests can override
// when exercising the non-taggable merge. The `...actual` spread
// preserves the other fs/promises exports other code paths may need.
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    readFile: vi.fn(() => {
      const err = new Error("ENOENT: no such file");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }),
  };
});

import * as fs from "node:fs";
import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { IAMClient } from "@aws-sdk/client-iam";
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
  vi.mocked(IAMClient).mockImplementation(
    () =>
      ({
        send: mockIamSend,
        destroy: mockIamDestroy,
      }) as unknown as IAMClient,
  );
  // Default: IAM ListRoles returns empty list so existing RGTA-only tests
  // are unaffected by the new IAM enumeration path.
  mockIamSend.mockResolvedValue({ Roles: [], IsTruncated: false });
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
    // e98.W1.B1 added the `keyKind` discriminator to ManagedResource so
    // CLI + MCP can distinguish ARN-keyed rows (taggable) from the new
    // primaryIdentifier-keyed rows (Route / SRTA / VPCGatewayAttachment).
    // Both rows below are taggable → keyKind === "arn".
    expect(resources[0]).toEqual({
      resourceType: "AWS::S3::Bucket",
      arn: "arn:aws:s3:::my-bucket-12345",
      keyKind: "arn",
      region: "us-east-1",
      createdDate: "2026-03-15T10:30:00Z",
      estimatedMonthlyCost: "N/A",
    });
    expect(resources[1]).toEqual({
      resourceType: "AWS::Lambda::Function",
      arn: "arn:aws:lambda:us-east-1:123456789012:function:my-function",
      keyKind: "arn",
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

  // Story 56-it1-03 L4-003: verify region is re-read per invocation
  // so a long-running MCP worker picks up `AWS_REGION` changes between
  // tool calls instead of serving the module-load snapshot.
  it("re-reads process.env.AWS_REGION per invocation (lazy capture)", async () => {
    const prevRegion = process.env["AWS_REGION"];
    try {
      const mockSend = getMockSend();
      mockSend.mockResolvedValue({
        ResourceTagMappingList: [],
        PaginationToken: undefined,
      });

      process.env["AWS_REGION"] = "us-east-1";
      await fetchManagedResources();
      const firstCall = vi
        .mocked(ResourceGroupsTaggingAPIClient)
        .mock.calls.at(-1)?.[0] as { region?: string } | undefined;

      process.env["AWS_REGION"] = "eu-west-1";
      await fetchManagedResources();
      const secondCall = vi
        .mocked(ResourceGroupsTaggingAPIClient)
        .mock.calls.at(-1)?.[0] as { region?: string } | undefined;

      expect(firstCall?.region).toBe("us-east-1");
      expect(secondCall?.region).toBe("eu-west-1");
      expect(firstCall?.region).not.toBe(secondCall?.region);
    } finally {
      if (prevRegion === undefined) delete process.env["AWS_REGION"];
      else process.env["AWS_REGION"] = prevRegion;
    }
  });

  it("falls back to DEFAULT_AWS_REGION when AWS_REGION is unset (per-invocation)", async () => {
    const prevRegion = process.env["AWS_REGION"];
    try {
      const mockSend = getMockSend();
      mockSend.mockResolvedValue({
        ResourceTagMappingList: [],
        PaginationToken: undefined,
      });

      delete process.env["AWS_REGION"];
      await fetchManagedResources();
      const firstCall = vi
        .mocked(ResourceGroupsTaggingAPIClient)
        .mock.calls.at(-1)?.[0] as { region?: string } | undefined;

      expect(firstCall?.region).toBeDefined();
      // DEFAULT_AWS_REGION from @assignee/core — real value (us-east-1
      // per the constant). Using the fallback directly rather than the
      // literal keeps the test resilient to a rename.
      const { DEFAULT_AWS_REGION } = await import("@assignee/core");
      expect(firstCall?.region).toBe(DEFAULT_AWS_REGION);
    } finally {
      if (prevRegion === undefined) delete process.env["AWS_REGION"];
      else process.env["AWS_REGION"] = prevRegion;
    }
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

// ── IAM role enumeration — N+1 fix (W17-S3) ─────────────────────────────────
//
// enumerateMcpIamRoles must fan-out ListRoleTags in bounded concurrent
// batches (IAM_TAG_FETCH_CONCURRENCY=10) using Promise.allSettled, so
// a single role's tag failure doesn't abort the whole enumeration.

describe("enumerateMcpIamRoles — concurrent ListRoleTags fan-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // RGTA returns no resources so all returned entries come from IAM.
    mockSend.mockResolvedValue({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });
  });

  it("fetches tags for all roles in a single page", async () => {
    // ListRoles returns 3 roles; ListRoleTags for each returns the
    // assignee managed-by tag so all 3 should surface in the result.
    mockIamSend
      .mockResolvedValueOnce({
        // ListRoles page 1 (only page)
        Roles: [
          {
            RoleName: "role-a",
            Arn: "arn:aws:iam::123456789012:role/role-a",
            CreateDate: new Date("2026-01-01"),
          },
          {
            RoleName: "role-b",
            Arn: "arn:aws:iam::123456789012:role/role-b",
            CreateDate: new Date("2026-01-02"),
          },
          {
            RoleName: "role-c",
            Arn: "arn:aws:iam::123456789012:role/role-c",
            CreateDate: new Date("2026-01-03"),
          },
        ],
        IsTruncated: false,
      })
      // ListRoleTags for role-a, role-b, role-c (order matches batch)
      .mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      })
      .mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      })
      .mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      });

    const resources = await fetchManagedResources("us-east-1");
    const iamRoles = resources.filter(
      (r) => r.resourceType === "AWS::IAM::Role",
    );
    expect(iamRoles).toHaveLength(3);
    expect(iamRoles.map((r) => r.arn).sort()).toEqual([
      "arn:aws:iam::123456789012:role/role-a",
      "arn:aws:iam::123456789012:role/role-b",
      "arn:aws:iam::123456789012:role/role-c",
    ]);
  });

  it("excludes roles whose tags do not include the assignee managed-by tag", async () => {
    mockIamSend
      .mockResolvedValueOnce({
        Roles: [
          {
            RoleName: "managed-role",
            Arn: "arn:aws:iam::123456789012:role/managed-role",
            CreateDate: new Date(),
          },
          {
            RoleName: "unmanaged-role",
            Arn: "arn:aws:iam::123456789012:role/unmanaged-role",
            CreateDate: new Date(),
          },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      })
      .mockResolvedValueOnce({ Tags: [{ Key: "env", Value: "prod" }] }); // no managed-by tag

    const resources = await fetchManagedResources("us-east-1");
    const iamRoles = resources.filter(
      (r) => r.resourceType === "AWS::IAM::Role",
    );
    expect(iamRoles).toHaveLength(1);
    expect(iamRoles[0]!.arn).toBe(
      "arn:aws:iam::123456789012:role/managed-role",
    );
  });

  it("skips a role whose ListRoleTags call fails without aborting enumeration", async () => {
    // role-a tag fetch fails; role-b and role-c should still be returned.
    mockIamSend
      .mockResolvedValueOnce({
        Roles: [
          {
            RoleName: "role-a",
            Arn: "arn:aws:iam::123456789012:role/role-a",
            CreateDate: new Date(),
          },
          {
            RoleName: "role-b",
            Arn: "arn:aws:iam::123456789012:role/role-b",
            CreateDate: new Date(),
          },
          {
            RoleName: "role-c",
            Arn: "arn:aws:iam::123456789012:role/role-c",
            CreateDate: new Date(),
          },
        ],
        IsTruncated: false,
      })
      .mockRejectedValueOnce(new Error("AccessDenied: role-a")) // role-a fails
      .mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      })
      .mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      });

    const resources = await fetchManagedResources("us-east-1");
    const iamRoles = resources.filter(
      (r) => r.resourceType === "AWS::IAM::Role",
    );
    // role-a skipped; role-b and role-c returned
    expect(iamRoles).toHaveLength(2);
    expect(iamRoles.map((r) => r.arn).sort()).toEqual([
      "arn:aws:iam::123456789012:role/role-b",
      "arn:aws:iam::123456789012:role/role-c",
    ]);
  });

  it("fans out tags across batches when more than 10 roles are present", async () => {
    // 12 roles → 2 batches (10 + 2). All tagged with managed-by.
    const roles = Array.from({ length: 12 }, (_, i) => ({
      RoleName: `role-${i}`,
      Arn: `arn:aws:iam::123456789012:role/role-${i}`,
      CreateDate: new Date(),
    }));

    // First call: ListRoles (all 12, single page)
    mockIamSend.mockResolvedValueOnce({ Roles: roles, IsTruncated: false });
    // Next 12 calls: ListRoleTags for each role
    for (let i = 0; i < 12; i++) {
      mockIamSend.mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      });
    }

    const resources = await fetchManagedResources("us-east-1");
    const iamRoles = resources.filter(
      (r) => r.resourceType === "AWS::IAM::Role",
    );
    expect(iamRoles).toHaveLength(12);
    // ListRoles (1) + ListRoleTags (12) = 13 IAM sends
    expect(mockIamSend).toHaveBeenCalledTimes(13);
  });

  it("handles paginated ListRoles across multiple pages", async () => {
    mockIamSend
      .mockResolvedValueOnce({
        // Page 1 of ListRoles
        Roles: [
          {
            RoleName: "role-p1",
            Arn: "arn:aws:iam::123456789012:role/role-p1",
            CreateDate: new Date(),
          },
        ],
        IsTruncated: true,
        Marker: "next-marker",
      })
      .mockResolvedValueOnce({
        // Page 2 of ListRoles
        Roles: [
          {
            RoleName: "role-p2",
            Arn: "arn:aws:iam::123456789012:role/role-p2",
            CreateDate: new Date(),
          },
        ],
        IsTruncated: false,
      })
      // ListRoleTags for both roles (batched together since ≤ 10)
      .mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      })
      .mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      });

    const resources = await fetchManagedResources("us-east-1");
    const iamRoles = resources.filter(
      (r) => r.resourceType === "AWS::IAM::Role",
    );
    expect(iamRoles).toHaveLength(2);
    expect(iamRoles.map((r) => r.arn).sort()).toEqual([
      "arn:aws:iam::123456789012:role/role-p1",
      "arn:aws:iam::123456789012:role/role-p2",
    ]);
  });

  it("returns empty array when ListRoles returns no roles", async () => {
    mockIamSend.mockResolvedValueOnce({ Roles: [], IsTruncated: false });

    const resources = await fetchManagedResources("us-east-1");
    const iamRoles = resources.filter(
      (r) => r.resourceType === "AWS::IAM::Role",
    );
    expect(iamRoles).toHaveLength(0);
    // Only ListRoles was called, no ListRoleTags needed
    expect(mockIamSend).toHaveBeenCalledTimes(1);
  });

  it("returns a ManagedResource entry with correct shape for a tagged role", async () => {
    mockIamSend
      .mockResolvedValueOnce({
        Roles: [
          {
            RoleName: "tagged-role",
            Arn: "arn:aws:iam::123456789012:role/tagged-role",
            CreateDate: new Date("2026-03-15"),
          },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Tags: [
          { Key: "managed-by", Value: "assignee-ai" },
          { Key: "env", Value: "staging" },
        ],
      });

    const resources = await fetchManagedResources("us-east-1");
    const iamRoles = resources.filter(
      (r) => r.resourceType === "AWS::IAM::Role",
    );
    expect(iamRoles).toHaveLength(1);
    const role = iamRoles[0]!;
    expect(role.arn).toBe("arn:aws:iam::123456789012:role/tagged-role");
    expect(role.resourceType).toBe("AWS::IAM::Role");
    expect(role.region).toBe("global");
    // createdDate comes from the IAM CreateDate (no provision log entry)
    expect(role.createdDate).toBe("2026-03-15T00:00:00.000Z");
    expect(role.keyKind).toBe("arn");
  });
});
