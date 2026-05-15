/**
 * Tests for discoverEcsClusters (EPIC-107-2).
 * Mocks @aws-sdk/client-ecs — no real AWS calls in CI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock ECS client ──────────────────────────────────────────────────────────

const mockSend = vi.fn();
vi.mock("@aws-sdk/client-ecs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-ecs")>();
  return {
    ...actual,
    ECSClient: vi.fn(() => ({ send: mockSend })),
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

import { discoverEcsClusters } from "./ecs.js";

describe("discoverEcsClusters", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns active clusters with service counts", async () => {
    // ListClusters → DescribeClusters
    mockSend
      .mockResolvedValueOnce({
        clusterArns: [
          "arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster",
          "arn:aws:ecs:us-east-1:123456789012:cluster/staging-cluster",
        ],
      })
      .mockResolvedValueOnce({
        clusters: [
          {
            clusterName: "my-cluster",
            clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster",
            status: "ACTIVE",
            activeServicesCount: 3,
          },
          {
            clusterName: "staging-cluster",
            clusterArn:
              "arn:aws:ecs:us-east-1:123456789012:cluster/staging-cluster",
            status: "ACTIVE",
            activeServicesCount: 1,
          },
        ],
      });
    const result = await discoverEcsClusters();
    expect(result).toHaveLength(2);
    expect(result[0]!.value).toBe("my-cluster");
    expect(result[0]!.label).toContain("3 services");
    expect(result[1]!.label).toContain("1 service");
    expect(result[1]!.label).not.toContain("1 services");
  });

  it("filters out inactive clusters", async () => {
    mockSend
      .mockResolvedValueOnce({
        clusterArns: ["arn:aws:ecs:us-east-1:123456789012:cluster/dead"],
      })
      .mockResolvedValueOnce({
        clusters: [
          { clusterName: "dead", status: "INACTIVE", activeServicesCount: 0 },
        ],
      });
    const result = await discoverEcsClusters();
    expect(result).toHaveLength(0);
  });

  it("returns [] when no cluster ARNs found", async () => {
    mockSend.mockResolvedValueOnce({ clusterArns: [] });
    const result = await discoverEcsClusters();
    expect(result).toHaveLength(0);
  });

  it("returns [] when ListClusters returns empty", async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await discoverEcsClusters();
    expect(result).toHaveLength(0);
  });
});
