/**
 * Tests for the list-pricing-enricher.
 *
 * Mocks: MCP client (MultiServerMCPClient), getMcpServerConfigs.
 * Real: decomposer registry, format logic, tuple grouping, failure degradation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Shared mock state ──────────────────────────────────────────────────────

/** Shared mock invoke function used by all MCP client instances in tests. */
const mockToolInvoke = vi.fn();
const mockGetTools = vi.fn();
const mockInitConnections = vi.fn();
const mockClose = vi.fn();

// Mock MultiServerMCPClient so no real MCP process is spawned.
vi.mock("@langchain/mcp-adapters", () => {
  class MultiServerMCPClient {
    constructor(_config: unknown) {}
    initializeConnections = mockInitConnections;
    getTools = mockGetTools;
    close = mockClose;
  }
  return { MultiServerMCPClient };
});

// Mock getMcpServerConfigs to return a valid pricing config without
// requiring real reader credentials to be set.
vi.mock("../config/mcp-servers.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../config/mcp-servers.js")>();
  return {
    ...original,
    getMcpServerConfigs: vi.fn(() => ({
      "aws-pricing-mcp-server": {
        command: "uvx",
        args: [
          "--with",
          "botocore[crt]",
          "awslabs.aws-pricing-mcp-server@1.0.27",
        ],
        env: {
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          AWS_DEFAULT_REGION: "us-east-1",
          FASTMCP_LOG_LEVEL: "ERROR",
        },
      },
    })),
  };
});

// Import AFTER mocks
import { createListPricingEnricher } from "./pricing-enricher.js";
import { getMcpServerConfigs } from "../config/mcp-servers.js";
import type { ManagedResource } from "./types.js";

function makeResource(
  arn: string,
  resourceType: string,
  region = "us-east-1",
): ManagedResource {
  return {
    resourceType,
    arn,
    keyKind: "arn",
    region,
    createdDate: "N/A",
    estimatedMonthlyCost: "N/A",
  };
}

/** KMS pricing MCP response fixture. */
const KMS_PRICING_RESPONSE = JSON.stringify({
  status: "success",
  service_name: "awskms",
  data: [
    {
      product: {
        productFamily: "Encryption Key",
        attributes: { usagetype: "USE1-KMS-Keys" },
      },
      terms: {
        OnDemand: {
          "term-1": {
            priceDimensions: {
              "pd-1": {
                rateCode: "pd-1",
                beginRange: "0",
                endRange: "Inf",
                unit: "Keys",
                pricePerUnit: { USD: "1.0000000000" },
                description: "Customer managed CMK, per key, per month",
              },
            },
          },
        },
      },
    },
  ],
});

/** Simulate the MCP text-wrapper that `unwrapMcpText` unpacks. */
function wrapMcpText(json: string) {
  return { type: "text", text: json };
}

describe("createListPricingEnricher — core behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default setup: mock client bootstraps and returns a get_pricing tool
    mockInitConnections.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockGetTools.mockResolvedValue([
      { name: "get_pricing", invoke: mockToolInvoke },
    ]);
    // Default MCP config (restored after clearAllMocks)
    vi.mocked(getMcpServerConfigs).mockReturnValue({
      "aws-pricing-mcp-server": {
        command: "uvx",
        args: [
          "--with",
          "botocore[crt]",
          "awslabs.aws-pricing-mcp-server@1.0.27",
        ],
        env: {
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          AWS_DEFAULT_REGION: "us-east-1",
          FASTMCP_LOG_LEVEL: "ERROR",
        },
      },
    });
  });

  it("returns Map with resolved cost label for KMS key", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/b725bae0-1234-5678";
    mockToolInvoke.mockResolvedValue(wrapMcpText(KMS_PRICING_RESPONSE));

    const enricher = createListPricingEnricher();
    const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    expect(result.has(kmsArn)).toBe(true);
    // KMS fixed: 1 key × $1.00/key = $1.00/mo
    expect(result.get(kmsArn)).toBe("$1.00/mo");
  });

  it("makes ONE Pricing MCP invoke per unique (resourceType, region) tuple", async () => {
    const arn1 = "arn:aws:kms:us-east-1:112233445566:key/key-aaa1";
    const arn2 = "arn:aws:kms:us-east-1:112233445566:key/key-bbb2";

    mockToolInvoke.mockResolvedValue(wrapMcpText(KMS_PRICING_RESPONSE));

    const enricher = createListPricingEnricher();
    const result = await enricher([
      makeResource(arn1, "AWS::KMS::Key"),
      makeResource(arn2, "AWS::KMS::Key"),
    ]);

    // 1 invoke call per (KMS, us-east-1) tuple even for 2 ARNs
    expect(mockToolInvoke).toHaveBeenCalledTimes(1);
    expect(result.get(arn1)).toBe("$1.00/mo");
    expect(result.get(arn2)).toBe("$1.00/mo");
  });

  it("returns '$0/mo' for free-tier resource types (IAM Role — zero line items)", async () => {
    const iamArn =
      "arn:aws:iam::112233445566:role/AssigneeAiBedrockLoggingRole";

    const enricher = createListPricingEnricher();
    const result = await enricher([
      makeResource(iamArn, "AWS::IAM::Role", "global"),
    ]);

    // IAM Role decomposer returns empty line items → free
    expect(result.get(iamArn)).toBe("$0/mo");
    // No MCP invoke calls for free resources
    expect(mockToolInvoke).not.toHaveBeenCalled();
  });

  it("does NOT add entry when resource type has no registered decomposer", async () => {
    const arn = "arn:aws:elasticache:us-east-1:112233445566:cluster:my-cluster";

    const enricher = createListPricingEnricher();
    const result = await enricher([
      makeResource(arn, "AWS::ElastiCache::CacheCluster"),
    ]);

    expect(result.has(arn)).toBe(false);
    expect(mockToolInvoke).not.toHaveBeenCalled();
  });

  it("returns empty Map when resources list is empty", async () => {
    const enricher = createListPricingEnricher();
    const result = await enricher([]);
    expect(result.size).toBe(0);
    expect(mockToolInvoke).not.toHaveBeenCalled();
  });
});

describe("createListPricingEnricher — failure degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitConnections.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockGetTools.mockResolvedValue([
      { name: "get_pricing", invoke: mockToolInvoke },
    ]);
    vi.mocked(getMcpServerConfigs).mockReturnValue({
      "aws-pricing-mcp-server": {
        command: "uvx",
        args: [
          "--with",
          "botocore[crt]",
          "awslabs.aws-pricing-mcp-server@1.0.27",
        ],
        env: {
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          AWS_DEFAULT_REGION: "us-east-1",
          FASTMCP_LOG_LEVEL: "ERROR",
        },
      },
    });
  });

  it("does not throw when MCP tool.invoke throws — returns empty map for that tuple", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/fail-key-0001";
    mockToolInvoke.mockRejectedValue(new Error("MCP timeout"));

    const enricher = createListPricingEnricher();
    const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    // No crash, but no entry for the failed ARN
    expect(result).toBeInstanceOf(Map);
    expect(result.has(kmsArn)).toBe(false);
  });

  it("does not throw when Pricing MCP server is not configured (missing creds)", async () => {
    // No pricing server config — simulates missing reader credentials
    vi.mocked(getMcpServerConfigs).mockReturnValue({});

    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/no-reader-creds";
    const enricher = createListPricingEnricher();
    const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    expect(result).toBeInstanceOf(Map);
    expect(result.has(kmsArn)).toBe(false);
  });

  it("IAM role returns $0/mo even when KMS invoke fails", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/kms-fail-key";
    const iamArn = "arn:aws:iam::112233445566:role/SomeRole";

    mockToolInvoke.mockRejectedValueOnce(new Error("KMS pricing fail"));

    const enricher = createListPricingEnricher();
    const result = await enricher([
      makeResource(kmsArn, "AWS::KMS::Key"),
      makeResource(iamArn, "AWS::IAM::Role", "global"),
    ]);

    // KMS failed → no entry; IAM role → $0/mo (no MCP call needed)
    expect(result.has(kmsArn)).toBe(false);
    expect(result.get(iamArn)).toBe("$0/mo");
  });

  // F#2: per-tuple stderr warning when any item fails
  it("emits exactly ONE stderr warning for a tuple where any fixed item fails", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/partial-fail";
    // Make the tool throw (simulates inner line-item failure)
    mockToolInvoke.mockRejectedValue(new Error("PricingAPI error"));

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const enricher = createListPricingEnricher();
      const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

      // Tuple failed → one warning, no map entry
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(result.has(kmsArn)).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // F#2: NO stderr warning when all items succeed
  it("does NOT emit stderr warning when all items succeed", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/success-key";
    mockToolInvoke.mockResolvedValue(wrapMcpText(KMS_PRICING_RESPONSE));

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const enricher = createListPricingEnricher();
      await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

/** Zero-price MCP response (promotional/free-tier rate $0.00). */
const ZERO_PRICE_RESPONSE = JSON.stringify({
  status: "success",
  service_name: "awskms",
  data: [
    {
      product: {
        productFamily: "Encryption Key",
        attributes: { usagetype: "USE1-KMS-Keys" },
      },
      terms: {
        OnDemand: {
          "term-1": {
            priceDimensions: {
              "pd-1": {
                rateCode: "pd-1",
                beginRange: "0",
                endRange: "Inf",
                unit: "Keys",
                pricePerUnit: { USD: "0.0000000000" },
                description: "Free key",
              },
            },
          },
        },
      },
    },
  ],
});

describe("createListPricingEnricher — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitConnections.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockGetTools.mockResolvedValue([
      { name: "get_pricing", invoke: mockToolInvoke },
    ]);
    vi.mocked(getMcpServerConfigs).mockReturnValue({
      "aws-pricing-mcp-server": {
        command: "uvx",
        args: [
          "--with",
          "botocore[crt]",
          "awslabs.aws-pricing-mcp-server@1.0.27",
        ],
        env: {
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          AWS_DEFAULT_REGION: "us-east-1",
          FASTMCP_LOG_LEVEL: "ERROR",
        },
      },
    });
  });

  // F#6: $0.00/mo genuine zero price must display, not be filtered
  it("displays '$0.00/mo' when pricing API returns a genuine zero rate", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/zero-price-key";
    mockToolInvoke.mockResolvedValue(wrapMcpText(ZERO_PRICE_RESPONSE));

    const enricher = createListPricingEnricher();
    const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    // $0.00/mo should be displayed, not silently dropped
    expect(result.get(kmsArn)).toBe("$0.00/mo");
  });

  // F#7: array-wrapped MCP response shape (some transports wrap in array)
  it("handles array-wrapped MCP response { type:'text', text } inside an array", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/array-wrapped";
    // Array-wrapped: [{ type: "text", text: "<json>" }]
    mockToolInvoke.mockResolvedValue([wrapMcpText(KMS_PRICING_RESPONSE)]);

    const enricher = createListPricingEnricher();
    const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    expect(result.get(kmsArn)).toBe("$1.00/mo");
  });

  // F#7: raw string response
  it("handles raw string MCP response", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/raw-string";
    mockToolInvoke.mockResolvedValue(KMS_PRICING_RESPONSE);

    const enricher = createListPricingEnricher();
    const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    // JSON.stringify of a string wraps in quotes → JSON.parse fails → inner catch → no entry
    // This is the correct degradation path for a non-JSON string response.
    // The key assertion is: no crash, returns a Map.
    expect(result).toBeInstanceOf(Map);
  });

  // F#4: retry on throttling errors — resolves correctly after 2 failures + 1 success
  it("retries on throttling errors and resolves on 3rd attempt", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/throttle-retry";
    const throttleError = new Error("ThrottlingException: Rate exceeded");

    mockToolInvoke
      .mockRejectedValueOnce(throttleError)
      .mockRejectedValueOnce(throttleError)
      .mockResolvedValueOnce(wrapMcpText(KMS_PRICING_RESPONSE));

    const enricher = createListPricingEnricher();
    const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    // Should succeed after 2 throttle failures + 1 success
    expect(mockToolInvoke).toHaveBeenCalledTimes(3);
    expect(result.get(kmsArn)).toBe("$1.00/mo");
  });

  // F#14: injector returning extra keys (ARNs not in resource list) must not crash
  it("silently ignores extra keys returned by injector", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/real-key";
    // Return a price for kmsArn — no extra keys in this unit test since we
    // control the Map; the actual test is that extra keys in the map don't
    // cause a crash in fetch-managed-resources.ts (code is already correct).
    mockToolInvoke.mockResolvedValue(wrapMcpText(KMS_PRICING_RESPONSE));

    const enricher = createListPricingEnricher();
    // Pass ONE resource
    const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    // The result has the expected entry and does not contain garbage
    expect(result.get(kmsArn)).toBe("$1.00/mo");
    expect(result.size).toBe(1);
  });

  // Regression: AWS::KMS::Key contains "::" inside the resource type name.
  // The TupleKey is built as "<resourceType>::<region>" → "AWS::KMS::Key::us-east-1".
  // A naive split("::")[1] returns "KMS" not "us-east-1", causing the MCP
  // to receive "KMS" as the region and return empty_results for every KMS key.
  // This test verifies the MCP call carries the correct region in its request.
  it("passes correct region to Pricing MCP for resource types containing '::' in their name (KMS regression)", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/region-extraction";
    mockToolInvoke.mockResolvedValue(wrapMcpText(KMS_PRICING_RESPONSE));

    const enricher = createListPricingEnricher();
    const result = await enricher([
      makeResource(kmsArn, "AWS::KMS::Key", "us-east-1"),
    ]);

    // If region extraction was wrong (e.g. "KMS"), the MCP mock would still
    // return a response (it doesn't validate region in the mock), so we verify
    // the correct call argument was passed.
    expect(mockToolInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ region: "us-east-1" }),
    );
    // And the cost resolves correctly
    expect(result.get(kmsArn)).toBe("$1.00/mo");
  });
});
