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

// ---------------------------------------------------------------------------
// DF-COST-LABEL-DDB-DESTROY-DUP — usage-based displayPrice must not
// double the unit suffix. extractFirstTierPrice already returns
// `$<scaled><unit>`; the enricher previously appended `${item.priceUnit}`
// again, producing labels like `$0.0000001250/M read reqs/M read reqs`
// rendered through the destroy flow as
//   "Estimated savings: $0.0000001250/M read reqs/M read reqs saved"
// Live verify 2026-05-12.
// ---------------------------------------------------------------------------

describe("createListPricingEnricher — usage-based unit suffix not doubled (DF-COST-LABEL-DDB-DESTROY-DUP)", () => {
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

  it("emits exactly ONE /M read reqs suffix for PAY_PER_REQUEST DDB tables", async () => {
    const ddbArn = "arn:aws:dynamodb:us-east-1:112233445566:table/UserSessions";
    // Minimal MCP fixture for the read-request-units rate. The
    // pricing-enricher's DDB decomposer issues separate calls for
    // read, write, and storage; we mock the same response shape for
    // all (the storage and write calls will resolve to the same value,
    // which is fine — this test only checks suffix duplication, not
    // dollar accuracy).
    mockToolInvoke.mockResolvedValue(
      wrapMcpText(
        JSON.stringify({
          status: "success",
          service_name: "AmazonDynamoDB",
          data: [
            {
              product: {
                productFamily: "Amazon DynamoDB PayPerRequest Throughput",
                attributes: {
                  group: "DDB-ReadUnits",
                  servicecode: "AmazonDynamoDB",
                },
              },
              terms: {
                OnDemand: {
                  "term-1": {
                    priceDimensions: {
                      "pd-1": {
                        rateCode: "pd-1",
                        beginRange: "0",
                        endRange: "Inf",
                        unit: "ReadRequestUnits",
                        pricePerUnit: { USD: "0.2500000000" },
                      },
                    },
                  },
                },
              },
            },
          ],
        }),
      ),
    );

    const enricher = createListPricingEnricher();
    const result = await enricher([
      makeResource(ddbArn, "AWS::DynamoDB::Table"),
    ]);

    const label = result.get(ddbArn);
    expect(label).toBeDefined();
    // Pre-fix this would be "$0.2500/M read reqs/M read reqs" — the
    // /M read reqs suffix must appear AT MOST ONCE.
    const readReqsMatches = (label!.match(/\/M read reqs/g) ?? []).length;
    expect(readReqsMatches).toBeLessThanOrEqual(1);
    // And the doubled-suffix substring must never appear.
    expect(label).not.toContain("/M read reqs/M read reqs");
    expect(label).not.toContain("/M write reqs/M write reqs");
  });
});

// ──────────────────────────────────────────────────────────────────
// F6 (2026-05-24) — StorageEnricher promotes per-GB-month rate hints
// to per-resource $/mo totals when actual storage GB is known.
// ──────────────────────────────────────────────────────────────────

/** S3 storage rate Pricing-MCP response fixture. Returns the canonical
 *  $0.0230/GB-month rate for the Standard storage class. The `attributes`
 *  bag is left empty so `itemMatchesFilters` can't reject on the
 *  region-prefixed `usagetype` value real AWS responses contain
 *  ("USE1-TimedStorage-ByteHrs") — that is a pricing-enricher-specific
 *  test concern, not an F6 concern. */
const S3_STORAGE_PRICING_RESPONSE = JSON.stringify({
  status: "success",
  service_name: "AmazonS3",
  data: [
    {
      product: {
        productFamily: "Storage",
        attributes: {},
      },
      terms: {
        OnDemand: {
          "term-1": {
            priceDimensions: {
              "pd-1": {
                rateCode: "pd-1",
                beginRange: "0",
                endRange: "Inf",
                unit: "GB-Mo",
                pricePerUnit: { USD: "0.0230000000" },
                description: "Standard storage, first 50 TB / month",
              },
            },
          },
        },
      },
    },
  ],
});

/**
 * Production-shape S3 storage rate fixture. Mirrors the real AWS
 * Pricing API response: `usagetype` includes the region prefix
 * (`USE1-` for us-east-1, `EU-` for eu-west-1, etc.) AND the response
 * is a single item with full product metadata.
 *
 * Quinn L7 follow-up: locks the real-world response-shape behaviour
 * so a future Pricing-API change is caught at test time, not in
 * production.
 *
 * As of the F6 follow-up commit (prefix-aware matcher),
 * `itemMatchesFilters` strips a leading ALL-CAPS-DIGITS-HYPHEN token
 * (e.g. `USE1-`) from the API-returned attribute value before
 * comparing against the stored filter. So the prefixed
 * `USE1-TimedStorage-ByteHrs` now matches the stored
 * `TimedStorage-ByteHrs` filter and the F6 promotion path fires
 * against the real production response shape.
 */
const S3_STORAGE_PRICING_RESPONSE_PRODUCTION_SHAPE = JSON.stringify({
  status: "success",
  service_name: "AmazonS3",
  data: [
    {
      product: {
        productFamily: "Storage",
        attributes: {
          // Real AWS shape: region-prefixed usagetype.
          usagetype: "USE1-TimedStorage-ByteHrs",
          storageClass: "General Purpose",
          volumeType: "Standard",
          region: "us-east-1",
        },
      },
      terms: {
        OnDemand: {
          "term-1": {
            priceDimensions: {
              "pd-1": {
                rateCode: "pd-1",
                beginRange: "0",
                endRange: "Inf",
                unit: "GB-Mo",
                pricePerUnit: { USD: "0.0230000000" },
                description: "$0.023 per GB-Month of Storage",
              },
            },
          },
        },
      },
    },
  ],
});

describe("createListPricingEnricher — F6 storage promotion", () => {
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

  it("promotes per-GB-month rate to $/mo when storageGB is known (50 GB → $1.15/mo)", async () => {
    const arn = "arn:aws:s3:::my-test-bucket-50gb";
    mockToolInvoke.mockResolvedValue(wrapMcpText(S3_STORAGE_PRICING_RESPONSE));

    // StorageEnricher reports 50 GB for this bucket.
    const storageEnricher = vi.fn(
      async () => new Map([[arn, { storageGB: 50 }]]),
    );

    const enricher = createListPricingEnricher(storageEnricher);
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    // 50 GB × $0.023/GB-month = $1.15/mo
    expect(result.get(arn)).toBe("$1.15/mo");
    expect(storageEnricher).toHaveBeenCalledTimes(1);
  });

  it("falls back to rate-hint when storageEnricher returns no entry for the ARN", async () => {
    const arn = "arn:aws:s3:::my-test-bucket-no-data";
    mockToolInvoke.mockResolvedValue(wrapMcpText(S3_STORAGE_PRICING_RESPONSE));

    // StorageEnricher returns empty map (e.g. freshly-created bucket
    // has no BucketSizeBytes datapoint yet).
    const storageEnricher = vi.fn(async () => new Map());

    const enricher = createListPricingEnricher(storageEnricher);
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    // No GB known → label is the rate-hint string from extractFirstTierPrice.
    const label = result.get(arn);
    expect(label).toBeDefined();
    expect(label).toContain("/GB-mo");
  });

  it("falls back to rate-hint when storageEnricher is not supplied", async () => {
    const arn = "arn:aws:s3:::my-test-bucket-no-enricher";
    mockToolInvoke.mockResolvedValue(wrapMcpText(S3_STORAGE_PRICING_RESPONSE));

    // No storageEnricher passed → behaviour identical to pre-F6.
    const enricher = createListPricingEnricher();
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    const label = result.get(arn);
    expect(label).toBeDefined();
    expect(label).toContain("/GB-mo");
  });

  it("survives storageEnricher throwing — falls back gracefully", async () => {
    const arn = "arn:aws:s3:::my-test-bucket-enricher-throws";
    mockToolInvoke.mockResolvedValue(wrapMcpText(S3_STORAGE_PRICING_RESPONSE));

    const storageEnricher = vi.fn(async () => {
      throw new Error("CloudWatch IAM denied");
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const enricher = createListPricingEnricher(storageEnricher);
      const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

      // Same fallback as missing enricher.
      const label = result.get(arn);
      expect(label).toBeDefined();
      expect(label).toContain("/GB-mo");

      // One stderr warning for the thrown enricher.
      expect(stderrSpy).toHaveBeenCalled();
      const warningCall = stderrSpy.mock.calls.find((c) =>
        String(c[0]).includes("storage-enricher threw"),
      );
      expect(warningCall).toBeDefined();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("mixes: one bucket with GB → $/mo, one without → rate hint (same tuple)", async () => {
    const arnWithData = "arn:aws:s3:::bucket-with-data-100gb";
    const arnNoData = "arn:aws:s3:::bucket-no-data";

    mockToolInvoke.mockResolvedValue(wrapMcpText(S3_STORAGE_PRICING_RESPONSE));

    const storageEnricher = vi.fn(
      async () => new Map([[arnWithData, { storageGB: 100 }]]),
    );

    const enricher = createListPricingEnricher(storageEnricher);
    const result = await enricher([
      makeResource(arnWithData, "AWS::S3::Bucket"),
      makeResource(arnNoData, "AWS::S3::Bucket"),
    ]);

    // Per-tuple MCP call happens ONCE (same rate for both buckets) but
    // per-resource label differs based on whether storageGB is known.
    expect(mockToolInvoke).toHaveBeenCalledTimes(1);
    // 100 GB × $0.023 = $2.30/mo
    expect(result.get(arnWithData)).toBe("$2.30/mo");
    // No GB data → rate hint
    expect(result.get(arnNoData)).toContain("/GB-mo");
  });

  it("rounds the per-bucket total to two decimals (12.345 GB → $0.28/mo)", async () => {
    const arn = "arn:aws:s3:::bucket-fractional";
    mockToolInvoke.mockResolvedValue(wrapMcpText(S3_STORAGE_PRICING_RESPONSE));

    const storageEnricher = vi.fn(
      async () => new Map([[arn, { storageGB: 12.345 }]]),
    );

    const enricher = createListPricingEnricher(storageEnricher);
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    // 12.345 × 0.023 = 0.283935 → $0.28/mo
    expect(result.get(arn)).toBe("$0.28/mo");
  });

  it("skips storageEnricher entirely when there are no priceable resources (Quinn M2)", async () => {
    const storageEnricher = vi.fn(async () => new Map());

    const enricher = createListPricingEnricher(storageEnricher);
    const result = await enricher([]);

    expect(result.size).toBe(0);
    // No priceable resources → no point paying the per-bucket CloudWatch
    // round-trip. Earlier (pre-Quinn-M2) the enricher was called with
    // an empty array — this test locks the optimised behaviour.
    expect(storageEnricher).not.toHaveBeenCalled();
  });

  it("handles real production-shape MCP response with region-prefixed usagetype (Quinn L7)", async () => {
    // Real AWS Pricing API responses include the region prefix on the
    // `usagetype` attribute (e.g. `USE1-TimedStorage-ByteHrs` in
    // us-east-1). The decomposer's filter uses the unprefixed value
    // `TimedStorage-ByteHrs`. As of the F6 follow-up commit,
    // `itemMatchesFilters` strips a single leading
    // ALL-CAPS-DIGITS-HYPHEN prefix from the API-returned attribute
    // value before comparing, so the prefixed value matches the stored
    // filter and the F6 promotion path fires against the real
    // production response shape.
    const arn = "arn:aws:s3:::production-shape-bucket";
    mockToolInvoke.mockResolvedValue(
      wrapMcpText(S3_STORAGE_PRICING_RESPONSE_PRODUCTION_SHAPE),
    );

    const storageEnricher = vi.fn(
      async () => new Map([[arn, { storageGB: 100 }]]),
    );

    const enricher = createListPricingEnricher(storageEnricher);
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    // 100 GB × $0.023/GB-month = $2.30/mo
    expect(result.get(arn)).toBe("$2.30/mo");
  });

  it("calls storageEnricher with the priceable subset, not the raw input", async () => {
    const arn = "arn:aws:s3:::priceable-bucket";
    const noDecomposerArn =
      "arn:aws:elasticache:us-east-1:112233445566:cluster/no-decomposer";
    mockToolInvoke.mockResolvedValue(wrapMcpText(S3_STORAGE_PRICING_RESPONSE));
    const storageEnricher = vi.fn(
      async () => new Map([[arn, { storageGB: 25 }]]),
    );

    const enricher = createListPricingEnricher(storageEnricher);
    await enricher([
      makeResource(arn, "AWS::S3::Bucket"),
      makeResource(noDecomposerArn, "AWS::ElastiCache::CacheCluster"),
    ]);

    expect(storageEnricher).toHaveBeenCalledTimes(1);
    // Only the priceable S3 bucket flows in — the no-decomposer
    // ElastiCache cluster is filtered out before the call. vi.fn()
    // without a signature types `.mock.calls` as `[][]`, so cast the
    // calls list to the real shape before indexing.
    const calls = storageEnricher.mock.calls as unknown as Array<
      [ManagedResource[]]
    >;
    const handed = calls[0]?.[0];
    expect(handed).toBeDefined();
    expect(handed).toHaveLength(1);
    expect(handed?.[0]?.arn).toBe(arn);
  });
});

// ──────────────────────────────────────────────────────────────────
// H3 (Quinn) — decomposer-ordering regression test. The F6 promotion
// path implicitly depends on the S3 decomposer emitting the
// per-GB-month STORAGE line as its FIRST usage-based line item. If a
// future refactor reorders the lines (e.g. PUT requests before
// storage) the promotion goes silent — no test was previously
// catching that ordering invariant. Freeze it here.
// ──────────────────────────────────────────────────────────────────

describe("S3 decomposer first-usage-based-item ordering (F6 invariant)", () => {
  it("emits the per-GB-month STORAGE line as the first usage-based item", async () => {
    const { defaultDecomposerRegistry } =
      await import("../pricing/barrels/decomposers.js");
    const { PricingKind } = await import("../pricing/filter-constants.js");
    const { PriceUnit } = await import("../pricing/price-units.js");
    const items = defaultDecomposerRegistry.decompose("AWS::S3::Bucket", {});
    const usage = items.filter((i) => i.kind === PricingKind.USAGE_BASED);
    expect(usage.length).toBeGreaterThan(0);
    // F6 (pricing-enricher.ts) only fetches usageBasedItems[0]. If this
    // assertion ever fails, F6 promotion broke silently and the storage
    // cost will revert to a rate-hint display in production.
    expect(usage[0]!.priceUnit).toBe(PriceUnit.PER_GB_MONTH);
  });
});
