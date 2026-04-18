import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./provision-log.js", () => ({
  loadProvisionData: vi.fn(() => ({
    costMap: new Map<string, string>(),
    timestampMap: new Map<string, string>(),
  })),
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
