/**
 * Tests for discoverDbSubnetGroups (EPIC-107-2).
 * Mocks @aws-sdk/client-rds — no real AWS calls in CI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock RDS client ──────────────────────────────────────────────────────────

const mockSend = vi.fn();
vi.mock("@aws-sdk/client-rds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-rds")>();
  return {
    ...actual,
    RDSClient: vi.fn(() => ({ send: mockSend })),
  };
});

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

import { discoverDbSubnetGroups } from "./rds-subnet-groups.js";

describe("discoverDbSubnetGroups", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns complete subnet groups with name and description", async () => {
    mockSend.mockResolvedValue({
      DBSubnetGroups: [
        {
          DBSubnetGroupName: "my-db-subnet-group",
          DBSubnetGroupDescription: "Public subnets for RDS",
          SubnetGroupStatus: "Complete",
        },
        {
          DBSubnetGroupName: "private-sg",
          DBSubnetGroupDescription: "Private subnets",
          SubnetGroupStatus: "Complete",
        },
      ],
    });
    const result = await discoverDbSubnetGroups();
    expect(result).toHaveLength(2);
    expect(result[0]!.value).toBe("my-db-subnet-group");
    expect(result[0]!.label).toContain("Public subnets for RDS");
  });

  it("filters out non-complete subnet groups", async () => {
    mockSend.mockResolvedValue({
      DBSubnetGroups: [
        {
          DBSubnetGroupName: "incomplete-sg",
          SubnetGroupStatus: "Pending",
          DBSubnetGroupDescription: "",
        },
        {
          DBSubnetGroupName: "ok-sg",
          SubnetGroupStatus: "Complete",
          DBSubnetGroupDescription: "",
        },
      ],
    });
    const result = await discoverDbSubnetGroups();
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe("ok-sg");
  });

  it("returns [] when response has no subnet groups", async () => {
    mockSend.mockResolvedValue({});
    const result = await discoverDbSubnetGroups();
    expect(result).toHaveLength(0);
  });
});
