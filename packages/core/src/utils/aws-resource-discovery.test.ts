import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock AWS SDK clients before importing the module under test.
const {
  mockEc2Send,
  mockSsmSend,
  mockRdsSend,
  mockEfsSend,
  mockSnsSend,
  mockKmsSend,
  mockWithTimeout,
} = vi.hoisted(() => ({
  mockEc2Send: vi.fn(),
  mockSsmSend: vi.fn(),
  mockRdsSend: vi.fn(),
  mockEfsSend: vi.fn(),
  mockSnsSend: vi.fn(),
  mockKmsSend: vi.fn(),
  mockWithTimeout: vi.fn(async (promise: Promise<unknown>) => promise),
}));

// NOTE: Constructor implementations use plain classes (not vi.fn) so they
// survive vitest's mockReset:true. The class instances close over the stable
// hoisted send mocks above.
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = vi.fn();
  }
  return {
    EC2Client,
    DescribeSubnetsCommand: vi.fn(),
    DescribeSecurityGroupsCommand: vi.fn(),
    DescribeKeyPairsCommand: vi.fn(),
    DescribeImagesCommand: vi.fn(),
    DescribeRouteTablesCommand: vi.fn(),
    DescribeInternetGatewaysCommand: vi.fn(),
    DescribeNatGatewaysCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-efs", () => {
  class EFSClient {
    send = mockEfsSend;
  }
  return {
    EFSClient,
    DescribeFileSystemsCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-sns", () => {
  class SNSClient {
    send = mockSnsSend;
  }
  return {
    SNSClient,
    ListTopicsCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-kms", () => {
  class KMSClient {
    send = mockKmsSend;
  }
  return {
    KMSClient,
    ListKeysCommand: vi.fn(),
    ListAliasesCommand: vi.fn(),
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
  discoverRouteTables,
  discoverInternetGateways,
  discoverNatGateways,
  discoverEfsFileSystems,
  discoverSnsTopics,
  discoverKmsKeys,
} from "./aws-resource-discovery/index.js";

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

    it("discoverRouteTables returns [] without invoking the SDK", async () => {
      const result = await discoverRouteTables();
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it("discoverInternetGateways returns [] without invoking the SDK", async () => {
      const result = await discoverInternetGateways();
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it("discoverNatGateways returns [] without invoking the SDK", async () => {
      const result = await discoverNatGateways();
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });

    it("discoverEfsFileSystems returns [] without invoking the SDK", async () => {
      const result = await discoverEfsFileSystems();
      expect(result).toEqual([]);
      expect(mockEfsSend).not.toHaveBeenCalled();
    });

    it("discoverSnsTopics returns [] without invoking the SDK", async () => {
      const result = await discoverSnsTopics();
      expect(result).toEqual([]);
      expect(mockSnsSend).not.toHaveBeenCalled();
    });

    it("discoverKmsKeys returns [] without invoking the SDK", async () => {
      const result = await discoverKmsKeys();
      expect(result).toEqual([]);
      expect(mockKmsSend).not.toHaveBeenCalled();
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

    // ── H4 regression: graceful degradation contract ───────────────────────
    // This test formalizes the "operator-only" use case: a user who has
    // configured ASSIGNEE_OPERATOR_* but NOT ASSIGNEE_READER_* must still
    // be able to run `assignee plan` — the wizard falls back to manual
    // entry instead of hard-failing. Discovery functions must return []
    // without throwing.
    it("operator-only config (reader unset) — discovery degrades to [] without throwing", async () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      // Reader explicitly unset from the outer beforeEach.
      delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];

      // None of these should throw.
      await expect(discoverSubnets()).resolves.toEqual([]);
      await expect(discoverSecurityGroups()).resolves.toEqual([]);
      await expect(discoverKeyPairs()).resolves.toEqual([]);
      await expect(discoverAmis()).resolves.toEqual([]);
      await expect(searchAmis("ml")).resolves.toEqual([]);
      await expect(discoverRdsEngineVersions()).resolves.toEqual([]);
      await expect(discoverRdsInstanceClasses()).resolves.toEqual([]);
      await expect(discoverRouteTables()).resolves.toEqual([]);
      await expect(discoverInternetGateways()).resolves.toEqual([]);
      await expect(discoverNatGateways()).resolves.toEqual([]);
      await expect(discoverEfsFileSystems()).resolves.toEqual([]);
      await expect(discoverSnsTopics()).resolves.toEqual([]);
      await expect(discoverKmsKeys()).resolves.toEqual([]);

      // Critical: not a single AWS SDK call was attempted — we never even
      // constructed a client, let alone sent a request.
      expect(mockEc2Send).not.toHaveBeenCalled();
      expect(mockSsmSend).not.toHaveBeenCalled();
      expect(mockRdsSend).not.toHaveBeenCalled();
      expect(mockEfsSend).not.toHaveBeenCalled();
      expect(mockSnsSend).not.toHaveBeenCalled();
      expect(mockKmsSend).not.toHaveBeenCalled();
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

  // ── discoverRouteTables ─────────────────────────────────────────────────

  describe("discoverRouteTables", () => {
    it("returns labelled options for route tables with Name tags", async () => {
      mockEc2Send.mockResolvedValueOnce({
        RouteTables: [
          {
            RouteTableId: "rtb-0123456789abcdef0",
            VpcId: "vpc-0abc123456",
            Tags: [{ Key: "Name", Value: "public-rt" }],
          },
        ],
      });
      const result = await discoverRouteTables();
      expect(result).toEqual([
        {
          value: "rtb-0123456789abcdef0",
          label: "public-rt (rtb-0123456789abcdef0, vpc: vpc-0abc123456)",
        },
      ]);
    });

    it("falls back to route table ID when no Name tag", async () => {
      mockEc2Send.mockResolvedValueOnce({
        RouteTables: [
          {
            RouteTableId: "rtb-0abcdef1234567890",
            VpcId: "vpc-xyz",
            Tags: [],
          },
        ],
      });
      const result = await discoverRouteTables();
      expect(result).toEqual([
        {
          value: "rtb-0abcdef1234567890",
          label: "rtb-0abcdef1234567890 (vpc: vpc-xyz)",
        },
      ]);
    });

    it("returns [] when API returns null", async () => {
      mockEc2Send.mockResolvedValueOnce(null);
      const result = await discoverRouteTables();
      expect(result).toEqual([]);
    });

    it("returns [] when API throws", async () => {
      mockEc2Send.mockRejectedValueOnce(new Error("access denied"));
      const result = await discoverRouteTables();
      expect(result).toEqual([]);
    });

    it("returns [] when reader credentials are absent", async () => {
      const savedKey = process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      const savedSecret = process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      const result = await discoverRouteTables();
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = savedKey;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = savedSecret;
    });
  });

  // ── discoverInternetGateways ────────────────────────────────────────────

  describe("discoverInternetGateways", () => {
    it("returns labelled options for IGWs with Name tags and VPC attachment", async () => {
      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: "igw-0123456789abcdef0",
            Attachments: [{ VpcId: "vpc-0abc123456", State: "available" }],
            Tags: [{ Key: "Name", Value: "main-igw" }],
          },
        ],
      });
      const result = await discoverInternetGateways();
      expect(result).toEqual([
        {
          value: "igw-0123456789abcdef0",
          label: "main-igw (igw-0123456789abcdef0, vpc: vpc-0abc123456)",
        },
      ]);
    });

    it("shows 'detached' when IGW has no VPC attachment", async () => {
      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: "igw-0abcdef1234567890",
            Attachments: [],
            Tags: [],
          },
        ],
      });
      const result = await discoverInternetGateways();
      expect(result[0]!.label).toContain("detached");
    });

    it("returns [] when API returns null", async () => {
      mockEc2Send.mockResolvedValueOnce(null);
      const result = await discoverInternetGateways();
      expect(result).toEqual([]);
    });

    it("returns [] when reader credentials are absent", async () => {
      const savedKey = process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      const savedSecret = process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      const result = await discoverInternetGateways();
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = savedKey;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = savedSecret;
    });

    // LOW-1: filter IGW attachments by State==="available" before picking VpcId
    it("LOW-1: shows 'detached' label when only a detaching attachment exists", async () => {
      // An IGW being detached from a VPC will have State="detaching"
      // — the label must show "detached", not the stale VPC ID.
      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: "igw-detaching1",
            Attachments: [
              // Only non-available attachment — should be ignored
              { VpcId: "vpc-being-detached", State: "detaching" },
            ],
            Tags: [{ Key: "Name", Value: "my-igw" }],
          },
        ],
      });
      const result = await discoverInternetGateways();
      expect(result).toHaveLength(1);
      // Must show "detached" — not the stale vpc-being-detached VpcId
      expect(result[0]!.label).toContain("detached");
      expect(result[0]!.label).not.toContain("vpc-being-detached");
    });

    it("LOW-1: shows the available VPC when an available attachment exists alongside a detaching one", async () => {
      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: "igw-mixed1",
            Attachments: [
              // Available attachment — should be used for the label
              { VpcId: "vpc-active-001", State: "available" },
              // Stale detaching attachment — must be ignored
              { VpcId: "vpc-stale-999", State: "detaching" },
            ],
            Tags: [],
          },
        ],
      });
      const result = await discoverInternetGateways();
      expect(result).toHaveLength(1);
      expect(result[0]!.label).toContain("vpc-active-001");
      expect(result[0]!.label).not.toContain("vpc-stale-999");
    });
  });

  // ── discoverNatGateways ─────────────────────────────────────────────────

  describe("discoverNatGateways", () => {
    it("returns labelled options for available NAT gateways with Name tags", async () => {
      mockEc2Send.mockResolvedValueOnce({
        NatGateways: [
          {
            NatGatewayId: "nat-0123456789abcdef0",
            SubnetId: "subnet-0abc123456",
            State: "available",
            Tags: [{ Key: "Name", Value: "public-nat" }],
          },
        ],
      });
      const result = await discoverNatGateways();
      expect(result).toEqual([
        {
          value: "nat-0123456789abcdef0",
          label:
            "public-nat (nat-0123456789abcdef0, subnet: subnet-0abc123456)",
        },
      ]);
    });

    it("falls back to NAT GW ID when no Name tag", async () => {
      mockEc2Send.mockResolvedValueOnce({
        NatGateways: [
          {
            NatGatewayId: "nat-0abcdef1234567890",
            SubnetId: "subnet-xyz",
            State: "available",
            Tags: [],
          },
        ],
      });
      const result = await discoverNatGateways();
      expect(result[0]!.label).toContain("subnet-xyz");
      expect(result[0]!.value).toBe("nat-0abcdef1234567890");
    });

    it("returns [] when API returns null", async () => {
      mockEc2Send.mockResolvedValueOnce(null);
      const result = await discoverNatGateways();
      expect(result).toEqual([]);
    });

    it("returns [] when reader credentials are absent", async () => {
      const savedKey = process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      const savedSecret = process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      const result = await discoverNatGateways();
      expect(result).toEqual([]);
      expect(mockEc2Send).not.toHaveBeenCalled();
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = savedKey;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = savedSecret;
    });
  });

  // ── discoverEfsFileSystems ─────────────────────────────────────────────

  describe("discoverEfsFileSystems", () => {
    it("returns labelled options for available EFS file systems with Name tags", async () => {
      mockEfsSend.mockResolvedValueOnce({
        FileSystems: [
          {
            FileSystemId: "fs-0123456789abcdef0",
            LifeCycleState: "available",
            SizeInBytes: { Value: 10737418240 }, // 10 GiB
            Tags: [{ Key: "Name", Value: "shared-storage" }],
          },
        ],
      });
      const result = await discoverEfsFileSystems();
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe("fs-0123456789abcdef0");
      expect(result[0]!.label).toContain("shared-storage");
      expect(result[0]!.label).toContain("fs-0123456789abcdef0");
    });

    it("filters out non-available file systems", async () => {
      mockEfsSend.mockResolvedValueOnce({
        FileSystems: [
          {
            FileSystemId: "fs-available",
            LifeCycleState: "available",
            Tags: [{ Key: "Name", Value: "ok" }],
          },
          {
            FileSystemId: "fs-creating",
            LifeCycleState: "creating",
            Tags: [{ Key: "Name", Value: "not-ready" }],
          },
          {
            FileSystemId: "fs-deleting",
            LifeCycleState: "deleting",
            Tags: [],
          },
        ],
      });
      const result = await discoverEfsFileSystems();
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe("fs-available");
    });

    it("falls back to file system ID as label when no Name tag", async () => {
      mockEfsSend.mockResolvedValueOnce({
        FileSystems: [
          {
            FileSystemId: "fs-0abcdef1234567890",
            LifeCycleState: "available",
            Tags: [],
          },
        ],
      });
      const result = await discoverEfsFileSystems();
      expect(result[0]!.value).toBe("fs-0abcdef1234567890");
      expect(result[0]!.label).toContain("fs-0abcdef1234567890");
    });

    it("returns [] when API returns null", async () => {
      mockEfsSend.mockResolvedValueOnce(null);
      const result = await discoverEfsFileSystems();
      expect(result).toEqual([]);
    });

    it("returns [] when reader credentials are absent", async () => {
      const savedKey = process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      const savedSecret = process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      const result = await discoverEfsFileSystems();
      expect(result).toEqual([]);
      expect(mockEfsSend).not.toHaveBeenCalled();
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = savedKey;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = savedSecret;
    });
  });

  // ── discoverSnsTopics ──────────────────────────────────────────────────

  describe("discoverSnsTopics", () => {
    it("returns labelled options with topic name extracted from ARN", async () => {
      mockSnsSend.mockResolvedValueOnce({
        Topics: [
          { TopicArn: "arn:aws:sns:us-east-1:210987654321:order-events" },
          { TopicArn: "arn:aws:sns:us-east-1:210987654321:user-notifications" },
        ],
      });
      const result = await discoverSnsTopics();
      expect(result).toHaveLength(2);
      expect(result[0]!.value).toBe(
        "arn:aws:sns:us-east-1:210987654321:order-events",
      );
      expect(result[0]!.label).toContain("order-events");
      expect(result[0]!.label).toContain(
        "arn:aws:sns:us-east-1:210987654321:order-events",
      );
      expect(result[1]!.value).toBe(
        "arn:aws:sns:us-east-1:210987654321:user-notifications",
      );
    });

    it("handles GovCloud partition ARNs", async () => {
      mockSnsSend.mockResolvedValueOnce({
        Topics: [
          {
            TopicArn: "arn:aws-us-gov:sns:us-gov-west-1:210987654321:gov-topic",
          },
        ],
      });
      const result = await discoverSnsTopics();
      expect(result[0]!.value).toContain("arn:aws-us-gov:sns");
      expect(result[0]!.label).toContain("gov-topic");
    });

    it("returns [] when Topics is empty", async () => {
      mockSnsSend.mockResolvedValueOnce({ Topics: [] });
      const result = await discoverSnsTopics();
      expect(result).toEqual([]);
    });

    it("returns [] when API returns null", async () => {
      mockSnsSend.mockResolvedValueOnce(null);
      const result = await discoverSnsTopics();
      expect(result).toEqual([]);
    });

    it("returns [] when reader credentials are absent", async () => {
      const savedKey = process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      const savedSecret = process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      const result = await discoverSnsTopics();
      expect(result).toEqual([]);
      expect(mockSnsSend).not.toHaveBeenCalled();
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = savedKey;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = savedSecret;
    });
  });

  // ── discoverKmsKeys ────────────────────────────────────────────────────

  describe("discoverKmsKeys", () => {
    it("returns customer-managed keys with alias labels", async () => {
      // ListKeys returns all keys; ListAliases returns aliases for CMKs
      mockKmsSend
        .mockResolvedValueOnce({
          Keys: [
            {
              KeyId: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
              KeyArn:
                "arn:aws:kms:us-east-1:210987654321:key/aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
            },
          ],
        })
        .mockResolvedValueOnce({
          Aliases: [
            {
              AliasName: "alias/my-app-key",
              TargetKeyId: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
            },
          ],
        });
      const result = await discoverKmsKeys();
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe(
        "arn:aws:kms:us-east-1:210987654321:key/aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
      );
      expect(result[0]!.label).toContain("alias/my-app-key");
      expect(result[0]!.label).toContain(
        "arn:aws:kms:us-east-1:210987654321:key/aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
      );
    });

    it("excludes AWS-managed keys (alias/aws/... aliases)", async () => {
      mockKmsSend
        .mockResolvedValueOnce({
          Keys: [
            {
              KeyId: "aws-managed-key-id",
              KeyArn:
                "arn:aws:kms:us-east-1:210987654321:key/aws-managed-key-id",
            },
            {
              KeyId: "customer-key-id",
              KeyArn: "arn:aws:kms:us-east-1:210987654321:key/customer-key-id",
            },
          ],
        })
        .mockResolvedValueOnce({
          Aliases: [
            {
              AliasName: "alias/aws/s3",
              TargetKeyId: "aws-managed-key-id",
            },
            {
              AliasName: "alias/my-cmk",
              TargetKeyId: "customer-key-id",
            },
          ],
        });
      const result = await discoverKmsKeys();
      // The aws-managed key has no custom alias after filtering alias/aws/ entries
      // The customer key maps to alias/my-cmk
      const values = result.map((r) => r.value);
      expect(values).not.toContain(
        "arn:aws:kms:us-east-1:210987654321:key/aws-managed-key-id",
      );
      // Customer key with alias/my-cmk remains
      expect(values).toContain(
        "arn:aws:kms:us-east-1:210987654321:key/customer-key-id",
      );
    });

    it("includes keys without custom aliases (bare CMKs)", async () => {
      mockKmsSend
        .mockResolvedValueOnce({
          Keys: [
            {
              KeyId: "bare-key-id",
              KeyArn: "arn:aws:kms:us-east-1:210987654321:key/bare-key-id",
            },
          ],
        })
        .mockResolvedValueOnce({
          Aliases: [], // No aliases at all
        });
      const result = await discoverKmsKeys();
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe(
        "arn:aws:kms:us-east-1:210987654321:key/bare-key-id",
      );
    });

    it("returns [] when Keys is empty", async () => {
      mockKmsSend
        .mockResolvedValueOnce({ Keys: [] })
        .mockResolvedValueOnce({ Aliases: [] });
      const result = await discoverKmsKeys();
      expect(result).toEqual([]);
    });

    it("returns [] when reader credentials are absent", async () => {
      const savedKey = process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      const savedSecret = process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      const result = await discoverKmsKeys();
      expect(result).toEqual([]);
      expect(mockKmsSend).not.toHaveBeenCalled();
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = savedKey;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = savedSecret;
    });

    // HIGH-1: graceful degradation when ListAliases fails (AccessDenied)
    it("HIGH-1: returns keys with bare-ARN labels when ListAliases fails (AccessDenied)", async () => {
      mockKmsSend
        .mockResolvedValueOnce({
          // ListKeys — succeeds with one key, not truncated
          Keys: [
            {
              KeyId: "cmk-id-001",
              KeyArn: "arn:aws:kms:us-east-1:210987654321:key/cmk-id-001",
            },
          ],
          Truncated: false,
        })
        .mockRejectedValueOnce(
          // ListAliases — fails with AccessDenied
          new Error(
            "AccessDeniedException: User is not authorized to list aliases",
          ),
        );

      const result = await discoverKmsKeys();
      // Key must still appear — bare ARN label because aliases are unavailable
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe(
        "arn:aws:kms:us-east-1:210987654321:key/cmk-id-001",
      );
      // Label is the bare ARN (no alias prefix) — degraded mode
      expect(result[0]!.label).toBe(
        "arn:aws:kms:us-east-1:210987654321:key/cmk-id-001",
      );
    });

    // HIGH-2: pagination — multi-page ListKeys
    // Note: listAllKeys and listAllAliases run concurrently via Promise.allSettled,
    // so mock responses interleave. The order is: listAllKeys fires call 1, then
    // listAllAliases fires call 2 (concurrently), then listAllKeys fires call 3
    // (page 2 continuation). We set up mocks in that exact interleaved order.
    it("HIGH-2: paginates ListKeys across multiple pages (interleaved with ListAliases)", async () => {
      mockKmsSend
        .mockResolvedValueOnce({
          // Call 1: listAllKeys page 1 — truncated (allSettled start)
          Keys: [
            {
              KeyId: "key-page1",
              KeyArn: "arn:aws:kms:us-east-1:210987654321:key/key-page1",
            },
          ],
          Truncated: true,
          NextMarker: "marker-page2",
        })
        .mockResolvedValueOnce({
          // Call 2: listAllAliases page 1 — not truncated (allSettled start, concurrent)
          Aliases: [
            { AliasName: "alias/page1-key", TargetKeyId: "key-page1" },
            { AliasName: "alias/page2-key", TargetKeyId: "key-page2" },
          ],
          Truncated: false,
        })
        .mockResolvedValueOnce({
          // Call 3: listAllKeys page 2 — not truncated (continuation after Truncated=true)
          Keys: [
            {
              KeyId: "key-page2",
              KeyArn: "arn:aws:kms:us-east-1:210987654321:key/key-page2",
            },
          ],
          Truncated: false,
        });

      const result = await discoverKmsKeys();
      // Both keys from both pages must appear
      expect(result).toHaveLength(2);
      const values = result.map((r) => r.value);
      expect(values).toContain(
        "arn:aws:kms:us-east-1:210987654321:key/key-page1",
      );
      expect(values).toContain(
        "arn:aws:kms:us-east-1:210987654321:key/key-page2",
      );
    });

    it("HIGH-2: paginates ListAliases to catch aliases on tail pages", async () => {
      // Non-truncated ListKeys, so the only interleaving is:
      // Call 1: listAllKeys page1 (not truncated — only one page)
      // Call 2: listAllAliases page1 (truncated)
      // Call 3: listAllAliases page2 (not truncated)
      mockKmsSend
        .mockResolvedValueOnce({
          // Call 1: ListKeys — single page, one CMK
          Keys: [
            {
              KeyId: "target-key-id",
              KeyArn: "arn:aws:kms:us-east-1:210987654321:key/target-key-id",
            },
          ],
          Truncated: false,
        })
        .mockResolvedValueOnce({
          // Call 2: ListAliases page 1 — aws-managed alias on this page (truncated)
          Aliases: [
            { AliasName: "alias/aws/s3", TargetKeyId: "aws-managed-key" },
          ],
          Truncated: true,
          NextMarker: "alias-marker-2",
        })
        .mockResolvedValueOnce({
          // Call 3: ListAliases page 2 — CMK alias on the tail page
          Aliases: [
            {
              AliasName: "alias/tail-page-alias",
              TargetKeyId: "target-key-id",
            },
          ],
          Truncated: false,
        });

      const result = await discoverKmsKeys();
      // The tail-page alias must be picked up
      expect(result).toHaveLength(1);
      expect(result[0]!.label).toContain("alias/tail-page-alias");
    });
  });

  // ── Story 44.4: discoverLambdaRuntimes ──────────────────────────────────
  describe("discoverLambdaRuntimes (Story 44.4)", () => {
    it("returns runtime options from the canonical list", async () => {
      const { discoverLambdaRuntimes, clearDiscoveryCache } =
        await import("./aws-resource-discovery/index.js");
      clearDiscoveryCache();
      const result = await discoverLambdaRuntimes();
      expect(result.length).toBeGreaterThanOrEqual(7);
      expect(result[0]).toHaveProperty("value");
      expect(result[0]).toHaveProperty("label");
      // Verify known runtimes are present
      const values = result.map((r: { value: string }) => r.value);
      expect(values).toContain("nodejs22.x");
      expect(values).toContain("python3.13");
      expect(values).toContain("provided.al2023");
    });

    it("returns cached results on second call", async () => {
      const { discoverLambdaRuntimes, clearDiscoveryCache } =
        await import("./aws-resource-discovery/index.js");
      clearDiscoveryCache();
      const first = await discoverLambdaRuntimes();
      const second = await discoverLambdaRuntimes();
      // Same reference from cache
      expect(first).toBe(second);
    });
  });
});
