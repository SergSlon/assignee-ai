import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock AWS SDK clients before importing the module under test.
const mockEc2Send = vi.fn();
const mockSsmSend = vi.fn();

vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: mockEc2Send })),
  DescribeSubnetsCommand: vi.fn(),
  DescribeSecurityGroupsCommand: vi.fn(),
  DescribeKeyPairsCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: vi.fn(),
}));

// Let withTimeout pass through (no real timer needed in tests).
vi.mock("./timeout.js", () => ({
  withTimeout: vi.fn(async (promise: Promise<unknown>) => promise),
}));

import {
  discoverSubnets,
  discoverSecurityGroups,
  discoverKeyPairs,
  discoverAmis,
  clearDiscoveryCache,
} from "./aws-resource-discovery.js";

describe("aws-resource-discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDiscoveryCache();
  });

  // ── discoverSubnets ──────────────────────────────────────────────────────

  describe("discoverSubnets", () => {
    it("returns labelled options for subnets with Name tags", async () => {
      mockEc2Send.mockResolvedValueOnce({
        Subnets: [
          {
            SubnetId: "subnet-111",
            CidrBlock: "10.0.1.0/24",
            AvailabilityZone: "us-east-1a",
            Tags: [{ Key: "Name", Value: "public-a" }],
          },
        ],
      });
      const result = await discoverSubnets();
      expect(result).toEqual([
        {
          value: "subnet-111",
          label: "public-a (10.0.1.0/24, us-east-1a) — subnet-111",
        },
      ]);
    });

    it("falls back to subnet ID when no Name tag", async () => {
      mockEc2Send.mockResolvedValueOnce({
        Subnets: [
          {
            SubnetId: "subnet-222",
            CidrBlock: "10.0.2.0/24",
            AvailabilityZone: "us-east-1b",
            Tags: [],
          },
        ],
      });
      const result = await discoverSubnets();
      expect(result).toEqual([
        {
          value: "subnet-222",
          label: "subnet-222 (10.0.2.0/24, us-east-1b)",
        },
      ]);
    });

    it("returns [] when API returns null", async () => {
      mockEc2Send.mockResolvedValueOnce(null);
      const result = await discoverSubnets();
      expect(result).toEqual([]);
    });

    it("returns [] when API throws", async () => {
      mockEc2Send.mockRejectedValueOnce(new Error("access denied"));
      const result = await discoverSubnets();
      expect(result).toEqual([]);
    });
  });

  // ── discoverSecurityGroups ─────────────────────────────────────────────

  describe("discoverSecurityGroups", () => {
    it("returns labelled options excluding default group", async () => {
      mockEc2Send.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: "sg-aaa",
            GroupName: "default",
            Description: "default VPC security group",
          },
          {
            GroupId: "sg-bbb",
            GroupName: "web-servers",
            Description: "HTTP/HTTPS ingress",
          },
        ],
      });
      const result = await discoverSecurityGroups();
      expect(result).toEqual([
        {
          value: "sg-bbb",
          label: "web-servers — HTTP/HTTPS ingress (sg-bbb)",
        },
      ]);
    });

    it("omits description suffix when it matches group name", async () => {
      mockEc2Send.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: "sg-ccc",
            GroupName: "my-sg",
            Description: "my-sg",
          },
        ],
      });
      const result = await discoverSecurityGroups();
      expect(result).toEqual([{ value: "sg-ccc", label: "my-sg (sg-ccc)" }]);
    });

    it("returns [] when API returns null", async () => {
      mockEc2Send.mockResolvedValueOnce(null);
      const result = await discoverSecurityGroups();
      expect(result).toEqual([]);
    });
  });

  // ── discoverKeyPairs ───────────────────────────────────────────────────

  describe("discoverKeyPairs", () => {
    it("prepends 'None' option and lists key pairs", async () => {
      mockEc2Send.mockResolvedValueOnce({
        KeyPairs: [{ KeyName: "dev-key", KeyType: "ed25519" }],
      });
      const result = await discoverKeyPairs();
      expect(result).toEqual([
        { value: "", label: "None (SSM access only)" },
        { value: "dev-key", label: "dev-key (ed25519)" },
      ]);
    });

    it("shows 'unknown' when KeyType is missing", async () => {
      mockEc2Send.mockResolvedValueOnce({
        KeyPairs: [{ KeyName: "legacy-key" }],
      });
      const result = await discoverKeyPairs();
      expect(result[1]).toEqual({
        value: "legacy-key",
        label: "legacy-key (unknown)",
      });
    });

    it("returns [] when API returns null", async () => {
      mockEc2Send.mockResolvedValueOnce(null);
      const result = await discoverKeyPairs();
      expect(result).toEqual([]);
    });
  });

  // ── discoverAmis ───────────────────────────────────────────────────────

  describe("discoverAmis", () => {
    it("returns AMI options from SSM parameters", async () => {
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "ami-12345678" },
      });
      const result = await discoverAmis();
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({
        value: "ami-12345678",
        label: "Amazon Linux 2023 (ami-12345678)",
      });
    });

    it("excludes AMIs where SSM returns no value", async () => {
      mockSsmSend
        .mockResolvedValueOnce({ Parameter: { Value: "ami-aaa" } })
        .mockResolvedValueOnce({ Parameter: {} }) // no Value
        .mockResolvedValueOnce({ Parameter: { Value: "ami-ccc" } })
        .mockRejectedValueOnce(new Error("not found"));
      const result = await discoverAmis();
      expect(result).toHaveLength(2);
      expect(result[0]!.value).toBe("ami-aaa");
      expect(result[1]!.value).toBe("ami-ccc");
    });

    it("returns [] when all SSM calls fail", async () => {
      mockSsmSend.mockRejectedValue(new Error("access denied"));
      const result = await discoverAmis();
      expect(result).toEqual([]);
    });
  });

  // ── Caching ────────────────────────────────────────────────────────────

  describe("session cache", () => {
    it("returns cached results on second call without re-fetching", async () => {
      mockEc2Send.mockResolvedValueOnce({
        KeyPairs: [{ KeyName: "k1", KeyType: "rsa" }],
      });
      const first = await discoverKeyPairs();
      const second = await discoverKeyPairs();
      expect(first).toEqual(second);
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });

    it("re-fetches after clearDiscoveryCache()", async () => {
      mockEc2Send
        .mockResolvedValueOnce({
          KeyPairs: [{ KeyName: "k1", KeyType: "rsa" }],
        })
        .mockResolvedValueOnce({
          KeyPairs: [{ KeyName: "k2", KeyType: "ed25519" }],
        });
      await discoverKeyPairs();
      clearDiscoveryCache();
      const result = await discoverKeyPairs();
      expect(result[1]!.value).toBe("k2");
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });

    it("does not cache empty results", async () => {
      mockEc2Send
        .mockResolvedValueOnce(null) // first call returns nothing
        .mockResolvedValueOnce({
          SecurityGroups: [
            { GroupId: "sg-x", GroupName: "x", Description: "x" },
          ],
        });
      const first = await discoverSecurityGroups();
      expect(first).toEqual([]);
      const second = await discoverSecurityGroups();
      expect(second).toHaveLength(1);
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });
  });
});
