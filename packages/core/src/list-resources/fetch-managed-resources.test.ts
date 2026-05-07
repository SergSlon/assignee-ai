import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./provision-log.js", () => ({
  loadProvisionData: vi.fn(() => ({
    costMap: new Map<string, string>(),
    timestampMap: new Map<string, string>(),
  })),
}));

// e98.W1.B1: the list path now also reads the provision log for non-
// taggable constructs. These tests assume an empty store unless they
// seed something explicit — mock the module to default to an empty
// projection. Individual tests can override via vi.mocked(...).
vi.mock("../managed-resources/index.js", () => ({
  listNonTaggableProvisionRecords: vi.fn(async () => []),
}));

import {
  fetchManagedResources,
  hasManagedByTag,
  type RgtaMapping,
  type ManagedIamRole,
} from "./fetch-managed-resources.js";
import * as provisionLog from "./provision-log.js";

const emptyLookup = {
  costMap: new Map<string, string>(),
  timestampMap: new Map<string, string>(),
};

describe("hasManagedByTag", () => {
  it("returns true when managed-by=assignee-ai is present", () => {
    expect(hasManagedByTag([{ Key: "managed-by", Value: "assignee-ai" }])).toBe(
      true,
    );
  });

  it("returns false when tag key is absent", () => {
    expect(hasManagedByTag([{ Key: "foo", Value: "bar" }])).toBe(false);
  });

  it("returns false when value mismatches", () => {
    expect(hasManagedByTag([{ Key: "managed-by", Value: "other" }])).toBe(
      false,
    );
  });

  it("returns false for undefined tags", () => {
    expect(hasManagedByTag(undefined)).toBe(false);
  });
});

describe("fetchManagedResources — basic RGTA path", () => {
  beforeEach(() => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue(emptyLookup);
  });

  it("translates RGTA mappings into ManagedResource[] with fallback N/A cost", async () => {
    const mappings: RgtaMapping[] = [
      {
        ResourceARN: "arn:aws:s3:::my-bucket-us-east",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
      {
        ResourceARN: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.arn).toBe("arn:aws:s3:::my-bucket-us-east");
    expect(result[0]!.estimatedMonthlyCost).toBe("N/A");
    expect(result[0]!.createdDate).toBe("N/A");
    expect(result[1]!.resourceType).toBe("AWS::DynamoDB::Table");
  });

  it("returns empty array on empty RGTA result", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => [],
    });
    expect(result).toEqual([]);
  });

  it("applies resourceTypeFilter when set", async () => {
    const mappings: RgtaMapping[] = [
      {
        ResourceARN: "arn:aws:s3:::bkt",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
      {
        ResourceARN: "arn:aws:dynamodb:us-east-1:111:table/t",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      resourceTypeFilter: "AWS::DynamoDB::Table",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.resourceType).toBe("AWS::DynamoDB::Table");
  });
});

describe("fetchManagedResources — partition-aware ARN parsing (feedback_partition_aware_arn_matching)", () => {
  beforeEach(() => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue(emptyLookup);
  });

  it("handles aws-cn ARNs correctly", async () => {
    const mappings: RgtaMapping[] = [
      {
        ResourceARN: "arn:aws-cn:s3:::cn-bucket",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "cn-north-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.arn).toBe("arn:aws-cn:s3:::cn-bucket");
    expect(result[0]!.resourceType).toBe("AWS::S3::Bucket");
  });

  it("handles aws-us-gov ARNs correctly", async () => {
    const mappings: RgtaMapping[] = [
      {
        ResourceARN:
          "arn:aws-us-gov:dynamodb:us-gov-west-1:123:table/gov-table",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "us-gov-west-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.resourceType).toBe("AWS::DynamoDB::Table");
  });
});

describe("fetchManagedResources — provision log enrichment", () => {
  it("uses costMap + timestampMap when provision log has the ARN", async () => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue({
      costMap: new Map([["arn:aws:s3:::ledger", "$12.34/month"]]),
      timestampMap: new Map([["arn:aws:s3:::ledger", "2026-03-01T10:00:00Z"]]),
    });
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => [
        {
          ResourceARN: "arn:aws:s3:::ledger",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
    });
    expect(result[0]!.estimatedMonthlyCost).toBe("$12.34/month");
    expect(result[0]!.createdDate).toBe("2026-03-01T10:00:00Z");
  });
});

describe("fetchManagedResources — createdDateFallback=run-id-tag (MCP path)", () => {
  beforeEach(() => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue(emptyLookup);
  });

  it("uses assignee-run-id tag when provision log is empty", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => [
        {
          ResourceARN: "arn:aws:s3:::x",
          Tags: [
            { Key: "managed-by", Value: "assignee-ai" },
            { Key: "assignee-run-id", Value: "run-abc-123" },
          ],
        },
      ],
      createdDateFallback: "run-id-tag",
    });
    expect(result[0]!.createdDate).toBe("run-abc-123");
  });

  it("falls back to N/A when run-id-tag is absent", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => [
        {
          ResourceARN: "arn:aws:s3:::x",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      createdDateFallback: "run-id-tag",
    });
    expect(result[0]!.createdDate).toBe("N/A");
  });
});

describe("fetchManagedResources — IAM role merge", () => {
  beforeEach(() => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue(emptyLookup);
  });

  it("appends IAM roles from the injector", async () => {
    const roles: ManagedIamRole[] = [
      {
        arn: "arn:aws:iam::123:role/assignee-op",
        roleName: "assignee-op",
        createdDate: "2026-04-01T00:00:00Z",
        tags: { "managed-by": "assignee-ai" },
      },
    ];
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => [],
      enrichWithIamRoles: async () => roles,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.resourceType).toBe("AWS::IAM::Role");
    expect(result[0]!.region).toBe("global");
  });

  it("skips IAM roles already present via RGTA (no dupes)", async () => {
    const roles: ManagedIamRole[] = [
      {
        arn: "arn:aws:iam::123:role/shared",
        roleName: "shared",
        createdDate: "2026-04-01T00:00:00Z",
        tags: {},
      },
    ];
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => [
        {
          ResourceARN: "arn:aws:iam::123:role/shared",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      enrichWithIamRoles: async () => roles,
    });
    expect(result).toHaveLength(1);
  });

  it("swallows IAM enumeration errors via callback", async () => {
    const errors: unknown[] = [];
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => [],
      enrichWithIamRoles: async () => {
        throw new Error("access denied");
      },
      onIamRoleEnumerationError: (err) => errors.push(err),
    });
    expect(result).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("access denied");
  });
});

describe("fetchManagedResources — global-service region display (Story e94.P2, D-06)", () => {
  beforeEach(() => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue(emptyLookup);
  });

  // Pre-fix: `region: parsed.region || region` leaked the operator's
  // configured region on every IAM ARN shape except IAM::Role (which
  // had a dedicated enrichment branch hardcoding `"global"`). The
  // fix applies `isGlobalService(parsed.service)` so all IAM shapes —
  // plus CloudFront / Route53 / WAF / Organizations — now display
  // `"global"` like the Role branch already did.
  it("stamps `region: global` on IAM ManagedPolicy ARN (D-06 fix)", async () => {
    const mappings: RgtaMapping[] = [
      {
        ResourceARN: "arn:aws:iam::112233445566:policy/assignee-deny-public",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.resourceType).toBe("AWS::IAM::ManagedPolicy");
    // Operator's region is us-east-1 but IAM is global — must render
    // as "global" so the user does not assume the policy is
    // region-scoped.
    expect(result[0]!.region).toBe("global");
  });

  it("stamps `region: global` on IAM User ARN", async () => {
    const mappings: RgtaMapping[] = [
      {
        ResourceARN: "arn:aws:iam::112233445566:user/assignee-operator",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "eu-west-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result[0]!.region).toBe("global");
  });

  it("stamps `region: global` on IAM Group ARN", async () => {
    const mappings: RgtaMapping[] = [
      {
        ResourceARN: "arn:aws:iam::112233445566:group/dev-team",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "ap-south-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result[0]!.region).toBe("global");
  });

  it("stamps `region: global` on CloudFront Distribution ARN", async () => {
    const mappings: RgtaMapping[] = [
      {
        ResourceARN: "arn:aws:cloudfront::112233445566:distribution/EABC123DEF",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result[0]!.region).toBe("global");
  });

  it("preserves regional ARNs untouched (no over-reach)", async () => {
    // Regression guard: the fix must not globalise regional ARNs.
    const mappings: RgtaMapping[] = [
      {
        ResourceARN: "arn:aws:lambda:eu-west-1:112233445566:function:worker",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
      {
        ResourceARN: "arn:aws:s3:::regional-bucket",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
    });
    // Lambda keeps its own region from the ARN.
    expect(result[0]!.region).toBe("eu-west-1");
    // S3 falls back to operator-default because the bucket itself is
    // regional even though the ARN has no region segment. S3 is NOT
    // in `GLOBAL_SERVICES` by design.
    expect(result[1]!.region).toBe("us-east-1");
  });

  it("partition-agnostic: GovCloud IAM ARN also displays as global", async () => {
    const mappings: RgtaMapping[] = [
      {
        ResourceARN: "arn:aws-us-gov:iam::112233445566:policy/gov-policy",
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];
    const result = await fetchManagedResources({
      region: "us-gov-west-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result[0]!.region).toBe("global");
  });
});

describe("fetchManagedResources — billing enrichment", () => {
  beforeEach(() => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue(emptyLookup);
  });

  it("overrides provision-log cost when billing returns a value", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => [
        {
          ResourceARN: "arn:aws:s3:::bill-me",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      enrichWithBilling: async () =>
        new Map([["arn:aws:s3:::bill-me", { actualMonthlyCost: "$99.99/mo" }]]),
    });
    expect(result[0]!.estimatedMonthlyCost).toBe("$99.99/mo");
  });

  it("silently falls back when billing throws (MCP unreachable)", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => [
        {
          ResourceARN: "arn:aws:s3:::ok",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      enrichWithBilling: async () => {
        throw new Error("MCP unreachable");
      },
    });
    expect(result[0]!.estimatedMonthlyCost).toBe("N/A");
  });
});

describe("fetchManagedResources — destroyed-ARN filter (BUG-9)", () => {
  beforeEach(() => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue(emptyLookup);
  });

  const ecsArn = "arn:aws:ecs:us-east-1:112233445566:cluster/my-cluster";
  const s3Arn = "arn:aws:s3:::my-bucket";

  const mappings: RgtaMapping[] = [
    {
      ResourceARN: ecsArn,
      Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
    },
    {
      ResourceARN: s3Arn,
      Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
    },
  ];

  it("filters out a destroyed ECS cluster ARN from RGTA output", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      getDestroyedArns: async () => new Set([ecsArn]),
    });
    expect(result.map((r) => r.arn)).not.toContain(ecsArn);
    expect(result.map((r) => r.arn)).toContain(s3Arn);
  });

  it("shows all resources when getDestroyedArns returns empty set", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      getDestroyedArns: async () => new Set(),
    });
    expect(result).toHaveLength(2);
  });

  it("shows all resources when getDestroyedArns is not injected", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result).toHaveLength(2);
  });

  it("gracefully degrades when getDestroyedArns throws", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      getDestroyedArns: async () => {
        throw new Error("disk full");
      },
    });
    expect(result).toHaveLength(2);
  });
});

// ── Pricing enrichment (feature-pricing-mcp-list-enrichment) ─────────────

describe("fetchManagedResources — pricing enrichment", () => {
  beforeEach(() => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue(emptyLookup);
  });

  const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/b725bae0-1234";
  const s3Arn = "arn:aws:s3:::my-bucket";

  const mappings: RgtaMapping[] = [
    {
      ResourceARN: kmsArn,
      Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
    },
    {
      ResourceARN: s3Arn,
      Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
    },
  ];

  it("calls enrichWithPricing for rows with N/A cost and replaces estimatedMonthlyCost", async () => {
    const enrichWithPricing = vi
      .fn()
      .mockResolvedValue(new Map([[kmsArn, "$1.00/mo"]]));

    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      enrichWithPricing,
    });

    expect(enrichWithPricing).toHaveBeenCalledTimes(1);
    const kmsRow = result.find((r) => r.arn === kmsArn);
    expect(kmsRow!.estimatedMonthlyCost).toBe("$1.00/mo");
  });

  it("does not call enrichWithPricing when no rows have N/A cost", async () => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue({
      costMap: new Map([
        [kmsArn, "$0.99/mo"],
        [s3Arn, "$0.50/mo"],
      ]),
      timestampMap: new Map(),
    });
    const enrichWithPricing = vi.fn().mockResolvedValue(new Map());

    await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      enrichWithPricing,
    });

    expect(enrichWithPricing).not.toHaveBeenCalled();
  });

  it("leaves row as N/A when enrichWithPricing returns empty Map", async () => {
    const enrichWithPricing = vi.fn().mockResolvedValue(new Map());

    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      enrichWithPricing,
    });

    const kmsRow = result.find((r) => r.arn === kmsArn);
    expect(kmsRow!.estimatedMonthlyCost).toBe("N/A");
  });

  it("does NOT crash when enrichWithPricing throws — output degrades gracefully", async () => {
    const enrichWithPricing = vi.fn().mockRejectedValue(new Error("MCP down"));

    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      enrichWithPricing,
    });

    // Should return 2 rows without throwing; cost stays N/A
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.estimatedMonthlyCost === "N/A")).toBe(true);
  });

  it("preserves Free label for IAM rows (regression check)", async () => {
    const iamArn = "arn:aws:iam::112233445566:policy/AssigneeAuditorPolicy";
    const iamMappings: RgtaMapping[] = [
      {
        ResourceARN: iamArn,
        Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
      },
    ];

    // useFreeTierFallback=true sets IAM rows to "Free" — pricing enricher
    // should only target N/A rows, so Free must survive.
    const enrichWithPricing = vi
      .fn()
      .mockResolvedValue(new Map([[iamArn, "$1.00/mo"]]));

    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => iamMappings,
      enrichWithPricing,
      useFreeTierFallback: true,
    });

    // The IAM policy row has a free-tier label — enrichWithPricing should
    // not have been called (no N/A rows).
    expect(enrichWithPricing).not.toHaveBeenCalled();
    const iamRow = result.find((r) => r.arn === iamArn);
    expect(iamRow!.estimatedMonthlyCost).not.toBe("$1.00/mo");
  });

  it("is a no-op when enrichWithPricing is undefined", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
    });
    // No injector — rows stay N/A but function does not throw
    expect(result).toHaveLength(2);
    expect(result[0]!.estimatedMonthlyCost).toBe("N/A");
  });
});

// ── Created-date enrichment (feature-list-created-date-enrichment) ────────

describe("fetchManagedResources — createdDate enrichment", () => {
  beforeEach(() => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue(emptyLookup);
  });

  const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/c64c1b61-5678";
  const s3Arn = "arn:aws:s3:::logs-bucket";

  const mappings: RgtaMapping[] = [
    {
      ResourceARN: kmsArn,
      Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
    },
    {
      ResourceARN: s3Arn,
      Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
    },
  ];

  it("calls enrichWithCreatedDate for rows with N/A date and sets createdDate", async () => {
    const enrichWithCreatedDate = vi
      .fn()
      .mockResolvedValue(new Map([[kmsArn, "2026-01-10"]]));

    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      enrichWithCreatedDate,
    });

    expect(enrichWithCreatedDate).toHaveBeenCalledTimes(1);
    const kmsRow = result.find((r) => r.arn === kmsArn);
    expect(kmsRow!.createdDate).toBe("2026-01-10");
  });

  it("does not call enrichWithCreatedDate when no rows have N/A date", async () => {
    vi.mocked(provisionLog.loadProvisionData).mockReturnValue({
      costMap: new Map(),
      timestampMap: new Map([
        [kmsArn, "2026-01-10"],
        [s3Arn, "2025-11-01"],
      ]),
    });
    const enrichWithCreatedDate = vi.fn().mockResolvedValue(new Map());

    await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      enrichWithCreatedDate,
    });

    expect(enrichWithCreatedDate).not.toHaveBeenCalled();
  });

  it("leaves row as N/A when enrichWithCreatedDate returns empty Map", async () => {
    const enrichWithCreatedDate = vi.fn().mockResolvedValue(new Map());

    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      enrichWithCreatedDate,
    });

    const kmsRow = result.find((r) => r.arn === kmsArn);
    expect(kmsRow!.createdDate).toBe("N/A");
  });

  it("does NOT crash when enrichWithCreatedDate throws — output degrades gracefully", async () => {
    const enrichWithCreatedDate = vi
      .fn()
      .mockRejectedValue(new Error("SDK unreachable"));

    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
      enrichWithCreatedDate,
    });

    // Should return 2 rows without throwing; dates stay N/A
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.createdDate === "N/A")).toBe(true);
  });

  it("is a no-op when enrichWithCreatedDate is undefined", async () => {
    const result = await fetchManagedResources({
      region: "us-east-1",
      fetchRgtaResources: async () => mappings,
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.createdDate).toBe("N/A");
  });
});
