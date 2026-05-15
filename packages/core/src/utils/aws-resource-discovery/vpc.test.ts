/**
 * Tests for discoverVpcs (EPIC-107-2).
 * Mocks @aws-sdk/client-ec2 — no real AWS calls in CI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock EC2 client ──────────────────────────────────────────────────────────

const mockSend = vi.fn();
vi.mock("../../aws/index.js", () => ({
  createEC2Client: vi.fn(() => ({ send: mockSend })),
}));

vi.mock("../../config/aws-credentials.js", () => ({
  tryAssigneeCredentials: vi.fn(() => ({
    accessKeyId: "test",
    secretAccessKey: "test",
    sessionToken: "test",
  })),
}));

vi.mock("./cache.js", () => ({
  cachedDiscover: vi.fn((_key: string, fetcher: () => unknown) => fetcher()),
}));

import { discoverVpcs } from "./vpc.js";

describe("discoverVpcs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns available VPCs with name tags", async () => {
    mockSend.mockResolvedValue({
      Vpcs: [
        {
          VpcId: "vpc-abc123",
          State: "available",
          CidrBlock: "172.31.0.0/16",
          IsDefault: true,
          Tags: [{ Key: "Name", Value: "default" }],
        },
        {
          VpcId: "vpc-staging",
          State: "available",
          CidrBlock: "10.0.0.0/16",
          IsDefault: false,
          Tags: [{ Key: "Name", Value: "staging" }],
        },
      ],
    });
    const result = await discoverVpcs();
    expect(result).toHaveLength(2);
    expect(result[0]!.value).toBe("vpc-abc123");
    expect(result[0]!.label).toContain("default");
    expect(result[0]!.label).toContain("[default]");
    expect(result[1]!.value).toBe("vpc-staging");
    expect(result[1]!.label).not.toContain("[default]");
  });

  it("filters out non-available VPCs", async () => {
    mockSend.mockResolvedValue({
      Vpcs: [
        {
          VpcId: "vpc-pending",
          State: "pending",
          CidrBlock: "10.0.0.0/16",
          IsDefault: false,
          Tags: [],
        },
        {
          VpcId: "vpc-ok",
          State: "available",
          CidrBlock: "10.1.0.0/16",
          IsDefault: false,
          Tags: [],
        },
      ],
    });
    const result = await discoverVpcs();
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe("vpc-ok");
  });

  it("returns [] when response has no Vpcs array", async () => {
    mockSend.mockResolvedValue({});
    const result = await discoverVpcs();
    expect(result).toHaveLength(0);
  });

  it("formats label without name tag (just vpc-id and cidr)", async () => {
    mockSend.mockResolvedValue({
      Vpcs: [
        {
          VpcId: "vpc-noname",
          State: "available",
          CidrBlock: "192.168.0.0/16",
          IsDefault: false,
          Tags: [],
        },
      ],
    });
    const result = await discoverVpcs();
    expect(result[0]!.label).toContain("vpc-noname");
    expect(result[0]!.label).toContain("192.168.0.0/16");
  });

  // EPIC-107-2 R2: BLOCKER #1 — region plumbing & pagination + cache-key

  it("passes region to createEC2Client (R2 BLOCKER #1)", async () => {
    const { createEC2Client } = await import("../../aws/index.js");
    mockSend.mockResolvedValue({ Vpcs: [] });
    await discoverVpcs("eu-west-1");
    expect(createEC2Client).toHaveBeenCalledWith(
      expect.objectContaining({ region: "eu-west-1" }),
    );
  });

  it("paginates via NextToken until exhausted (R2 MED #5)", async () => {
    mockSend
      .mockResolvedValueOnce({
        Vpcs: [
          {
            VpcId: "vpc-page1",
            State: "available",
            CidrBlock: "10.0.0.0/16",
            IsDefault: false,
            Tags: [],
          },
        ],
        NextToken: "tok-2",
      })
      .mockResolvedValueOnce({
        Vpcs: [
          {
            VpcId: "vpc-page2",
            State: "available",
            CidrBlock: "10.1.0.0/16",
            IsDefault: false,
            Tags: [],
          },
        ],
        // No NextToken — last page
      });
    const result = await discoverVpcs("us-east-1");
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.value)).toEqual(["vpc-page1", "vpc-page2"]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
