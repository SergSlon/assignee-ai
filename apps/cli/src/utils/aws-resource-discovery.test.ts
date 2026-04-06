import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock AWS SDK clients before importing the module under test.
const { mockEc2Send, mockSsmSend, mockRdsSend, mockWithTimeout } = vi.hoisted(
  () => ({
    mockEc2Send: vi.fn(),
    mockSsmSend: vi.fn(),
    mockRdsSend: vi.fn(),
    mockWithTimeout: vi.fn(async (promise: Promise<unknown>) => promise),
  }),
);

// NOTE: Constructor implementations use plain classes (not vi.fn) so they
// survive vitest's mockReset:true. The class instances close over the stable
// hoisted send mocks above.
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
  }
  return {
    EC2Client,
    DescribeSubnetsCommand: vi.fn(),
    DescribeSecurityGroupsCommand: vi.fn(),
    DescribeKeyPairsCommand: vi.fn(),
    DescribeImagesCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-ssm", () => {
  class SSMClient {
    send = mockSsmSend;
  }
  return {
    SSMClient,
    GetParameterCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-rds", () => {
  class RDSClient {
    send = mockRdsSend;
  }
  return {
    RDSClient,
    DescribeDBEngineVersionsCommand: vi.fn(),
    DescribeOrderableDBInstanceOptionsCommand: vi.fn(),
  };
});

// Let withTimeout pass through (no real timer needed in tests).
vi.mock("./timeout.js", () => ({
  withTimeout: mockWithTimeout,
}));

import {
  discoverSubnets,
  discoverSecurityGroups,
  discoverKeyPairs,
  discoverAmis,
  discoverRdsEngineVersions,
  discoverRdsInstanceClasses,
  searchAmis,
  clearDiscoveryCache,
} from "./aws-resource-discovery.js";

describe("aws-resource-discovery", () => {
  // Snapshot env so per-test mutations don't leak between cases
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    clearDiscoveryCache();
    // Reset withTimeout to default pass-through after timeout tests
    mockWithTimeout.mockImplementation(
      async (promise: Promise<unknown>) => promise,
    );
    // Provide reader credentials for the centralized helper. The discovery
    // module now hard-fails (gracefully — caught by cachedDiscover) when
    // ASSIGNEE_READER_* env vars are missing instead of silently sending
    // empty-string credentials to AWS.
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // ── Fail-closed credential enforcement ───────────────────────────────────
  // When reader credentials are missing, all discover*() helpers must
  // gracefully return [] (best-effort no-op) — never fall through to the
  // default AWS credential chain or send empty-string credentials.

  describe("fail-closed when ASSIGNEE_READER_* env vars are missing", () => {
    beforeEach(() => {
      delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      // Belt-and-suspenders: shell AWS_* must NOT be honored either
      process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";
    });

    it("discoverSubnets returns [] without invoking the SDK", async () => {
      const result = await discoverSubnets();
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it("discoverSecurityGroups returns [] without invoking the SDK", async () => {
      const result = await discoverSecurityGroups();
      // discoverSecurityGroups would otherwise return at least the "None"
      // option — fail-closed must short-circuit before that.
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it("discoverKeyPairs returns [] without invoking the SDK", async () => {
      const result = await discoverKeyPairs();
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it("discoverAmis returns [] without invoking the SDK", async () => {
      const result = await discoverAmis();
      expect(result).toEqual([]);
      expect(mockSsmSend).not.toHaveBeenCalled();
    });

    it("discoverRdsEngineVersions returns [] without invoking the SDK", async () => {
      const result = await discoverRdsEngineVersions({ Engine: "postgres" });
      expect(result).toEqual([]);
      expect(mockRdsSend).not.toHaveBeenCalled();
    });

    it("discoverRdsInstanceClasses returns [] without invoking the SDK", async () => {
      const result = await discoverRdsInstanceClasses({ Engine: "postgres" });
      expect(result).toEqual([]);
      expect(mockRdsSend).not.toHaveBeenCalled();
    });

    it("searchAmis returns [] without invoking the SDK", async () => {
      const result = await searchAmis("deep learning");
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });
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
    it("prepends 'None' option and lists SGs excluding default group", async () => {
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
        { value: "", label: "None (use VPC default security group)" },
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
      expect(result).toEqual([
        { value: "", label: "None (use VPC default security group)" },
        { value: "sg-ccc", label: "my-sg (sg-ccc)" },
      ]);
    });

    it("returns 'None' option when API returns null", async () => {
      mockEc2Send.mockResolvedValueOnce(null);
      const result = await discoverSecurityGroups();
      expect(result).toEqual([
        { value: "", label: "None (use VPC default security group)" },
      ]);
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

    it("does not cache empty results (uses subnets as example)", async () => {
      mockEc2Send
        .mockResolvedValueOnce(null) // first call returns nothing
        .mockResolvedValueOnce({
          Subnets: [
            {
              SubnetId: "subnet-abc",
              CidrBlock: "10.0.1.0/24",
              AvailabilityZone: "us-east-1a",
            },
          ],
        });
      const first = await discoverSubnets();
      expect(first).toEqual([]);
      const second = await discoverSubnets();
      expect(second).toHaveLength(1);
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });
  });

  // ── discoverRdsEngineVersions ───────────────────────────────────────────

  describe("discoverRdsEngineVersions", () => {
    it("returns versions sorted newest-first with recommended on latest", async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBEngineVersions: [
          {
            EngineVersion: "14.9",
            DBEngineVersionDescription: "PostgreSQL 14.9",
          },
          {
            EngineVersion: "16.1",
            DBEngineVersionDescription: "PostgreSQL 16.1",
          },
          {
            EngineVersion: "15.4",
            DBEngineVersionDescription: "PostgreSQL 15.4",
          },
          {
            EngineVersion: "13.12",
            DBEngineVersionDescription: "PostgreSQL 13.12",
          },
        ],
      });
      const result = await discoverRdsEngineVersions();
      expect(result).toHaveLength(4);
      // Newest first
      expect(result[0]!.value).toBe("16.1");
      expect(result[1]!.value).toBe("15.4");
      expect(result[2]!.value).toBe("14.9");
      expect(result[3]!.value).toBe("13.12");
      // First (newest) has recommended
      expect(result[0]).toHaveProperty("recommended", true);
      // Others do not
      expect(result[1]).not.toHaveProperty("recommended");
      expect(result[2]).not.toHaveProperty("recommended");
      expect(result[3]).not.toHaveProperty("recommended");
    });

    it("deduplicates versions", async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBEngineVersions: [
          {
            EngineVersion: "16.1",
            DBEngineVersionDescription: "PostgreSQL 16.1",
          },
          {
            EngineVersion: "16.1",
            DBEngineVersionDescription: "PostgreSQL 16.1 (dup)",
          },
          {
            EngineVersion: "15.4",
            DBEngineVersionDescription: "PostgreSQL 15.4",
          },
        ],
      });
      const result = await discoverRdsEngineVersions();
      expect(result).toHaveLength(2);
      expect(result[0]!.value).toBe("16.1");
      expect(result[1]!.value).toBe("15.4");
    });

    it("uses description from API as label", async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBEngineVersions: [
          {
            EngineVersion: "16.1",
            DBEngineVersionDescription: "PostgreSQL 16.1",
          },
        ],
      });
      const result = await discoverRdsEngineVersions();
      expect(result[0]!.label).toBe("PostgreSQL 16.1");
    });

    it("falls back to EngineVersion as label when description is missing", async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBEngineVersions: [{ EngineVersion: "15.4" }],
      });
      const result = await discoverRdsEngineVersions();
      expect(result[0]!.label).toBe("15.4");
    });

    it("returns [] when API returns empty DBEngineVersions", async () => {
      mockRdsSend.mockResolvedValueOnce({ DBEngineVersions: [] });
      const result = await discoverRdsEngineVersions();
      expect(result).toEqual([]);
    });

    it("returns [] when API returns null", async () => {
      mockRdsSend.mockResolvedValueOnce(null);
      const result = await discoverRdsEngineVersions();
      expect(result).toEqual([]);
    });

    it("returns [] on timeout", async () => {
      mockWithTimeout.mockRejectedValueOnce(new Error("timeout"));
      const result = await discoverRdsEngineVersions();
      expect(result).toEqual([]);
    });

    it("passes Engine filter from context (default postgres)", async () => {
      const { DescribeDBEngineVersionsCommand } =
        await import("@aws-sdk/client-rds");
      mockRdsSend.mockResolvedValueOnce({ DBEngineVersions: [] });
      await discoverRdsEngineVersions();
      expect(DescribeDBEngineVersionsCommand).toHaveBeenCalledWith({
        Engine: "postgres",
        DefaultOnly: false,
      });
    });

    it("passes custom Engine filter from context", async () => {
      const { DescribeDBEngineVersionsCommand } =
        await import("@aws-sdk/client-rds");
      mockRdsSend.mockResolvedValueOnce({ DBEngineVersions: [] });
      await discoverRdsEngineVersions({ Engine: "mysql" });
      expect(DescribeDBEngineVersionsCommand).toHaveBeenCalledWith({
        Engine: "mysql",
        DefaultOnly: false,
      });
    });

    it("caches results — second call does not re-fetch", async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBEngineVersions: [
          {
            EngineVersion: "16.1",
            DBEngineVersionDescription: "PostgreSQL 16.1",
          },
        ],
      });
      const first = await discoverRdsEngineVersions();
      const second = await discoverRdsEngineVersions();
      expect(first).toEqual(second);
      expect(mockRdsSend).toHaveBeenCalledTimes(1);
    });
  });

  // ── discoverRdsInstanceClasses ──────────────────────────────────────────

  describe("discoverRdsInstanceClasses", () => {
    it("returns deduplicated classes grouped burstable → general → memory → other", async () => {
      mockRdsSend.mockResolvedValueOnce({
        OrderableDBInstanceOptions: [
          { DBInstanceClass: "db.r6g.large" },
          { DBInstanceClass: "db.t3.micro" },
          { DBInstanceClass: "db.m5.large" },
          { DBInstanceClass: "db.t3.micro" }, // duplicate
          { DBInstanceClass: "db.r6g.xlarge" },
          { DBInstanceClass: "db.m5.xlarge" },
          { DBInstanceClass: "db.x2g.large" }, // memory family (x)
        ],
        Marker: undefined,
      });
      const result = await discoverRdsInstanceClasses();
      // Deduplicated: 6 unique classes
      expect(result).toHaveLength(6);

      // Burstable first
      expect(result[0]!.value).toBe("db.t3.micro");
      // General next
      expect(result[1]!.value).toBe("db.m5.large");
      expect(result[2]!.value).toBe("db.m5.xlarge");
      // Memory after general
      const memoryValues = result.filter(
        (o) => o.value.startsWith("db.r") || o.value.startsWith("db.x"),
      );
      expect(memoryValues).toHaveLength(3);
    });

    it("handles paginated responses", async () => {
      mockRdsSend
        .mockResolvedValueOnce({
          OrderableDBInstanceOptions: [{ DBInstanceClass: "db.t3.micro" }],
          Marker: "page2",
        })
        .mockResolvedValueOnce({
          OrderableDBInstanceOptions: [{ DBInstanceClass: "db.m5.large" }],
          Marker: undefined,
        });
      const result = await discoverRdsInstanceClasses();
      expect(result).toHaveLength(2);
      expect(result[0]!.value).toBe("db.t3.micro"); // burstable first
      expect(result[1]!.value).toBe("db.m5.large"); // general second
      expect(mockRdsSend).toHaveBeenCalledTimes(2);
    });

    it("returns [] when API returns empty OrderableDBInstanceOptions", async () => {
      mockRdsSend.mockResolvedValueOnce({
        OrderableDBInstanceOptions: [],
        Marker: undefined,
      });
      const result = await discoverRdsInstanceClasses();
      expect(result).toEqual([]);
    });

    it("returns [] when API returns null", async () => {
      mockRdsSend.mockResolvedValueOnce(null);
      const result = await discoverRdsInstanceClasses();
      expect(result).toEqual([]);
    });

    it("returns [] on timeout", async () => {
      mockWithTimeout.mockRejectedValueOnce(new Error("timeout"));
      const result = await discoverRdsInstanceClasses();
      expect(result).toEqual([]);
    });

    it("passes Engine filter from context (default postgres)", async () => {
      const { DescribeOrderableDBInstanceOptionsCommand } =
        await import("@aws-sdk/client-rds");
      mockRdsSend.mockResolvedValueOnce({
        OrderableDBInstanceOptions: [],
        Marker: undefined,
      });
      await discoverRdsInstanceClasses();
      expect(DescribeOrderableDBInstanceOptionsCommand).toHaveBeenCalledWith({
        Engine: "postgres",
      });
    });

    it("passes custom Engine filter from context", async () => {
      const { DescribeOrderableDBInstanceOptionsCommand } =
        await import("@aws-sdk/client-rds");
      mockRdsSend.mockResolvedValueOnce({
        OrderableDBInstanceOptions: [],
        Marker: undefined,
      });
      await discoverRdsInstanceClasses({ Engine: "mysql" });
      expect(DescribeOrderableDBInstanceOptionsCommand).toHaveBeenCalledWith({
        Engine: "mysql",
      });
    });

    it("caches results — second call does not re-fetch", async () => {
      mockRdsSend.mockResolvedValueOnce({
        OrderableDBInstanceOptions: [{ DBInstanceClass: "db.t3.micro" }],
        Marker: undefined,
      });
      const first = await discoverRdsInstanceClasses();
      const second = await discoverRdsInstanceClasses();
      expect(first).toEqual(second);
      expect(mockRdsSend).toHaveBeenCalledTimes(1);
    });

    it("uses class name as both value and label", async () => {
      mockRdsSend.mockResolvedValueOnce({
        OrderableDBInstanceOptions: [{ DBInstanceClass: "db.t3.micro" }],
        Marker: undefined,
      });
      const result = await discoverRdsInstanceClasses();
      expect(result[0]).toEqual({ value: "db.t3.micro", label: "db.t3.micro" });
    });
  });

  // ── Shape invariant tests ──────────────────────────────────────────────

  describe("shape invariants", () => {
    /**
     * Every discovery option must have:
     * - `value` as a non-empty string (except key pairs and security groups "None" options which use "")
     * - `label` as a non-empty string
     * - `value` never equals "false" or "undefined"
     */
    function assertShapeInvariants(
      options: Array<{ value: string; label: string }>,
      allowEmptyValue = false,
    ) {
      for (const opt of options) {
        expect(typeof opt.value).toBe("string");
        expect(typeof opt.label).toBe("string");
        expect(opt.label.length).toBeGreaterThan(0);
        if (!allowEmptyValue) {
          expect(opt.value.length).toBeGreaterThan(0);
        }
        expect(opt.value).not.toBe("false");
        expect(opt.value).not.toBe("undefined");
      }
    }

    it("discoverRdsEngineVersions returns well-shaped options", async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBEngineVersions: [
          {
            EngineVersion: "16.1",
            DBEngineVersionDescription: "PostgreSQL 16.1",
          },
          {
            EngineVersion: "15.4",
            DBEngineVersionDescription: "PostgreSQL 15.4",
          },
        ],
      });
      const result = await discoverRdsEngineVersions();
      assertShapeInvariants(result);
    });

    it("discoverRdsInstanceClasses returns well-shaped options", async () => {
      mockRdsSend.mockResolvedValueOnce({
        OrderableDBInstanceOptions: [
          { DBInstanceClass: "db.t3.micro" },
          { DBInstanceClass: "db.m5.large" },
          { DBInstanceClass: "db.r6g.large" },
        ],
        Marker: undefined,
      });
      const result = await discoverRdsInstanceClasses();
      assertShapeInvariants(result);
    });

    it("discoverSubnets returns well-shaped options", async () => {
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
      assertShapeInvariants(result);
    });

    it("discoverSecurityGroups returns well-shaped options (allows empty value for None)", async () => {
      mockEc2Send.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: "sg-bbb",
            GroupName: "web-servers",
            Description: "HTTP/HTTPS",
          },
        ],
      });
      const result = await discoverSecurityGroups();
      assertShapeInvariants(
        result,
        true /* allowEmptyValue for "None" option */,
      );
    });

    it("discoverKeyPairs returns well-shaped options (allows empty value for None)", async () => {
      mockEc2Send.mockResolvedValueOnce({
        KeyPairs: [{ KeyName: "my-key", KeyType: "rsa" }],
      });
      const result = await discoverKeyPairs();
      assertShapeInvariants(
        result,
        true /* allowEmptyValue for "None" option */,
      );
    });

    it("discoverAmis returns well-shaped options", async () => {
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "ami-12345678" },
      });
      const result = await discoverAmis();
      assertShapeInvariants(result);
    });
  });

  // ── searchAmis ──────────────────────────────────────────────────────────

  describe("searchAmis", () => {
    it("returns matching AMIs sorted by creation date (newest first)", async () => {
      mockEc2Send.mockResolvedValueOnce({
        Images: [
          {
            ImageId: "ami-older",
            Name: "Deep Learning AMI (Ubuntu 22.04)",
            CreationDate: "2025-01-01T00:00:00Z",
          },
          {
            ImageId: "ami-newer",
            Name: "Deep Learning Base AMI (Ubuntu 24.04)",
            CreationDate: "2026-02-15T00:00:00Z",
          },
        ],
      });
      const result = await searchAmis("deep learning");
      expect(result).toHaveLength(2);
      expect(result[0]!.value).toBe("ami-newer");
      expect(result[0]!.label).toContain("Deep Learning Base AMI");
      expect(result[0]!.label).toContain("ami-newer");
      expect(result[1]!.value).toBe("ami-older");
    });

    it("returns at most 5 results", async () => {
      const images = Array.from({ length: 8 }, (_, i) => ({
        ImageId: `ami-${i}`,
        Name: `ML AMI ${i}`,
        CreationDate: `2026-01-0${i + 1}T00:00:00Z`,
      }));
      mockEc2Send.mockResolvedValueOnce({ Images: images });
      const result = await searchAmis("ML");
      expect(result).toHaveLength(5);
    });

    it("returns [] when no images match", async () => {
      mockEc2Send.mockResolvedValueOnce({ Images: [] });
      const result = await searchAmis("nonexistent");
      expect(result).toEqual([]);
    });

    it("returns [] when API returns null", async () => {
      mockEc2Send.mockResolvedValueOnce(null);
      const result = await searchAmis("deep learning");
      expect(result).toEqual([]);
    });

    it("returns [] when API throws", async () => {
      mockEc2Send.mockRejectedValueOnce(new Error("access denied"));
      const result = await searchAmis("ml training");
      expect(result).toEqual([]);
    });

    it("returns [] for empty query", async () => {
      const result = await searchAmis("   ");
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it("caches results per query string", async () => {
      mockEc2Send.mockResolvedValueOnce({
        Images: [
          {
            ImageId: "ami-cached",
            Name: "ML AMI",
            CreationDate: "2026-01-01T00:00:00Z",
          },
        ],
      });
      const first = await searchAmis("ml training");
      const second = await searchAmis("ml training");
      expect(first).toEqual(second);
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });

    it("uses 'Unnamed AMI' label when Name is missing", async () => {
      mockEc2Send.mockResolvedValueOnce({
        Images: [
          {
            ImageId: "ami-noname",
            CreationDate: "2026-01-01T00:00:00Z",
          },
        ],
      });
      const result = await searchAmis("something");
      expect(result[0]!.label).toContain("Unnamed AMI");
      expect(result[0]!.label).toContain("ami-noname");
    });

    it("passes correct filters to DescribeImagesCommand", async () => {
      const { DescribeImagesCommand } = await import("@aws-sdk/client-ec2");
      mockEc2Send.mockResolvedValueOnce({ Images: [] });
      await searchAmis("deep learning");
      expect(DescribeImagesCommand).toHaveBeenCalledWith({
        Filters: [
          { Name: "name", Values: ["*deep*learning*"] },
          { Name: "state", Values: ["available"] },
          { Name: "is-public", Values: ["true"] },
        ],
        Owners: ["amazon"],
      });
    });
  });
});
