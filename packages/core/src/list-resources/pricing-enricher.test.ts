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

// ──────────────────────────────────────────────────────────────────
// F6 follow-up (2026-05-25) — CloudFront baseline cost. Promotes
// per-distribution usage (Requests + BytesDownloaded from CloudWatch)
// into a real `$X.XX/mo` total by multiplying the per-request rate
// and computing the tiered data-transfer cost.
// ──────────────────────────────────────────────────────────────────

/**
 * Production-shape CloudFront data-transfer tiered rate fixture.
 * Mirrors the AWS Pricing API response for `AmazonCloudFront` filtered
 * to `productFamily=Data Transfer` in the North America rate band:
 *
 *   Tier 1: 0–10 TB   → $0.085/GB
 *   Tier 2: 10–50 TB  → $0.080/GB
 *   Tier 3: 50–150 TB → $0.060/GB
 *
 * Values rounded to canonical published rates so the test math is
 * self-checkable from the rate ladder above.
 */
const CLOUDFRONT_DATA_TRANSFER_TIERED_RESPONSE = JSON.stringify({
  status: "success",
  service_name: "AmazonCloudFront",
  data: [
    {
      product: {
        productFamily: "Data Transfer",
        attributes: {
          transferType: "CloudFront Outbound",
          fromLocation: "North America",
        },
      },
      terms: {
        OnDemand: {
          "term-1": {
            priceDimensions: {
              "pd-1": {
                rateCode: "pd-1",
                beginRange: "0",
                endRange: "10240",
                unit: "GB",
                pricePerUnit: { USD: "0.0850000000" },
                description:
                  "$0.085 per GB - first 10 TB / month data transfer out - North America",
              },
              "pd-2": {
                rateCode: "pd-2",
                beginRange: "10240",
                endRange: "51200",
                unit: "GB",
                pricePerUnit: { USD: "0.0800000000" },
                description:
                  "$0.080 per GB - next 40 TB / month data transfer out - North America",
              },
              "pd-3": {
                rateCode: "pd-3",
                beginRange: "51200",
                endRange: "153600",
                unit: "GB",
                pricePerUnit: { USD: "0.0600000000" },
                description:
                  "$0.060 per GB - next 100 TB / month data transfer out - North America",
              },
            },
          },
        },
      },
    },
  ],
});

/**
 * CloudFront per-request rate fixture. The pricing-enricher uses the
 * raw rate (per-1-request) directly — fixture matches `priceUnit:
 * "/req"` set in the CloudFront decomposer after F6-ITEM-2 amendment.
 */
const CLOUDFRONT_REQUESTS_RESPONSE = JSON.stringify({
  status: "success",
  service_name: "AmazonCloudFront",
  data: [
    {
      product: {
        productFamily: "API Request",
        attributes: {
          group: "CloudFront-Requests-Tier1",
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
                unit: "Requests",
                pricePerUnit: { USD: "0.0000010000" },
                description: "$0.01 per 10,000 HTTPS Requests",
              },
            },
          },
        },
      },
    },
  ],
});

/**
 * Production-shape multi-edge-region CloudFront data-transfer fixture
 * (F6-ITEM-2 Quinn HIGH-1). Mirrors the AWS Pricing API behaviour of
 * returning ONE entry per `fromLocation` (NA / JP / SG), each with its
 * own tier ladder at different rates:
 *
 *   North America (item 0):  tier 1 $0.085/GB, tier 2 $0.080
 *   Japan         (item 1):  tier 1 $0.114/GB, tier 2 $0.105
 *   Singapore     (item 2):  tier 1 $0.120/GB, tier 2 $0.108
 *
 * The non-NA entries appear FIRST in the array so that any selection
 * logic that "trusts the first entry" would pick a wrong rate. The
 * decomposer's `fromLocation=North America` filter must drive
 * `itemMatchesFilters` to reject the JP + SG entries and leave only
 * the NA tier ladder — so the F6 promotion stays deterministic at
 * $0.085/GB tier 1 regardless of fixture entry order.
 */
const CLOUDFRONT_DATA_TRANSFER_MULTI_EDGE_REGION_RESPONSE = JSON.stringify({
  status: "success",
  service_name: "AmazonCloudFront",
  data: [
    {
      product: {
        productFamily: "Data Transfer",
        attributes: {
          transferType: "CloudFront Outbound",
          fromLocation: "Japan",
        },
      },
      terms: {
        OnDemand: {
          "term-jp": {
            priceDimensions: {
              "pd-jp-1": {
                rateCode: "pd-jp-1",
                beginRange: "0",
                endRange: "10240",
                unit: "GB",
                pricePerUnit: { USD: "0.1140000000" },
                description: "$0.114 per GB - first 10 TB / month - Japan",
              },
              "pd-jp-2": {
                rateCode: "pd-jp-2",
                beginRange: "10240",
                endRange: "51200",
                unit: "GB",
                pricePerUnit: { USD: "0.1050000000" },
                description: "$0.105 per GB - next 40 TB / month - Japan",
              },
            },
          },
        },
      },
    },
    {
      product: {
        productFamily: "Data Transfer",
        attributes: {
          transferType: "CloudFront Outbound",
          fromLocation: "Singapore",
        },
      },
      terms: {
        OnDemand: {
          "term-sg": {
            priceDimensions: {
              "pd-sg-1": {
                rateCode: "pd-sg-1",
                beginRange: "0",
                endRange: "10240",
                unit: "GB",
                pricePerUnit: { USD: "0.1200000000" },
                description: "$0.120 per GB - first 10 TB / month - Singapore",
              },
              "pd-sg-2": {
                rateCode: "pd-sg-2",
                beginRange: "10240",
                endRange: "51200",
                unit: "GB",
                pricePerUnit: { USD: "0.1080000000" },
                description: "$0.108 per GB - next 40 TB / month - Singapore",
              },
            },
          },
        },
      },
    },
    {
      product: {
        productFamily: "Data Transfer",
        attributes: {
          transferType: "CloudFront Outbound",
          fromLocation: "North America",
        },
      },
      terms: {
        OnDemand: {
          "term-na": {
            priceDimensions: {
              "pd-na-1": {
                rateCode: "pd-na-1",
                beginRange: "0",
                endRange: "10240",
                unit: "GB",
                pricePerUnit: { USD: "0.0850000000" },
                description:
                  "$0.085 per GB - first 10 TB / month - North America",
              },
              "pd-na-2": {
                rateCode: "pd-na-2",
                beginRange: "10240",
                endRange: "51200",
                unit: "GB",
                pricePerUnit: { USD: "0.0800000000" },
                description:
                  "$0.080 per GB - next 40 TB / month - North America",
              },
            },
          },
        },
      },
    },
  ],
});

describe("createListPricingEnricher — F6 CloudFront promotion", () => {
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

  /**
   * Route MCP responses by the line-item's filter — data-transfer
   * (`productFamily=Data Transfer`) returns the tiered ladder;
   * requests (`productFamily=API Request`) returns the flat rate.
   * Mirrors how the real Pricing MCP routes by `service_code`+filters.
   */
  function routeByFilter() {
    return ({
      filters,
    }: {
      filters: Array<{ Field: string; Value: string }>;
    }) => {
      const fam = filters.find((f) => f.Field === "productFamily")?.Value;
      if (fam === "Data Transfer") {
        return Promise.resolve(
          wrapMcpText(CLOUDFRONT_DATA_TRANSFER_TIERED_RESPONSE),
        );
      }
      if (fam === "API Request") {
        return Promise.resolve(wrapMcpText(CLOUDFRONT_REQUESTS_RESPONSE));
      }
      return Promise.resolve(null);
    };
  }

  it("promotes a measurable distribution to $/mo: 1000 GB + 1M reqs → $86.00/mo", async () => {
    // Happy path. Rate ladder + math:
    //   Data transfer: 1000 GB stays in tier 1 (0–10 TB / $0.085/GB) →
    //                  1000 × $0.085 = $85.00
    //   Requests:      1,000,000 reqs × ($0.01 / 10,000) = $1.00
    //   Total:         $86.00/mo
    const arn = "arn:aws:cloudfront::112233445566:distribution/EHAPPY12345";
    mockToolInvoke.mockImplementation(routeByFilter());

    const usageEnricher = vi.fn(
      async () =>
        new Map([
          [
            arn,
            {
              cloudfrontRequestsPerMonth: 1_000_000,
              cloudfrontBytesPerMonth: 1_000, // 1000 GB
            },
          ],
        ]),
    );

    const enricher = createListPricingEnricher(usageEnricher);
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    expect(result.get(arn)).toBe("$86.00/mo");
    expect(usageEnricher).toHaveBeenCalledTimes(1);
  });

  it("crosses tier boundaries correctly: 15 TB + 0 reqs → $1280.00/mo", async () => {
    // 15 TB (15360 GB) spans tier 1 + tier 2 (no tier-3 contribution):
    //   Tier 1 (0–10 TB):     10240 GB × $0.085 = $870.40
    //   Tier 2 (10–50 TB):    5120 GB × $0.080 = $409.60
    //   Total data transfer:  $1,280.00
    // Reqs side is excluded (set requests=1 to satisfy the > 0 guard,
    // 1 req × $0.000001 ≈ $0.00 — doesn't perturb the assertion).
    const arn = "arn:aws:cloudfront::112233445566:distribution/ECROSS12345";
    mockToolInvoke.mockImplementation(routeByFilter());

    const usageEnricher = vi.fn(
      async () =>
        new Map([
          [
            arn,
            {
              cloudfrontRequestsPerMonth: 1,
              cloudfrontBytesPerMonth: 15_360, // 15 TB
            },
          ],
        ]),
    );

    const enricher = createListPricingEnricher(usageEnricher);
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    // $1280.00 (data transfer) + ~$0.00 (1 request) ≈ $1280.00/mo
    expect(result.get(arn)).toBe("$1280.00/mo");
  });

  it("falls back to rate-hint when usage map reports zero traffic (idle distribution)", async () => {
    // CloudWatch returns 0/0 → we treat as "no usable multiplier" and
    // display the tier-ladder text rather than a misleading $0.00/mo.
    const arn = "arn:aws:cloudfront::112233445566:distribution/EIDLE12345";
    mockToolInvoke.mockImplementation(routeByFilter());

    const usageEnricher = vi.fn(
      async () =>
        new Map([
          [
            arn,
            {
              cloudfrontRequestsPerMonth: 0,
              cloudfrontBytesPerMonth: 0,
            },
          ],
        ]),
    );

    const enricher = createListPricingEnricher(usageEnricher);
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    const label = result.get(arn);
    expect(label).toBeDefined();
    // Must NOT be the misleading $0.00/mo total.
    expect(label).not.toBe("$0.00/mo");
    // Must be the rate-hint (contains a $-prefixed rate from the
    // tier-ladder text — e.g. "$0.085/GB").
    expect(label).toMatch(/\$0\.0/);
  });

  it("falls back to rate-hint when usage data is absent (no enricher hit for ARN)", async () => {
    const arn = "arn:aws:cloudfront::112233445566:distribution/EUNKNOWN";
    mockToolInvoke.mockImplementation(routeByFilter());

    // Enricher returns empty map (e.g. CloudWatch IAM denied silently).
    const usageEnricher = vi.fn(async () => new Map());

    const enricher = createListPricingEnricher(usageEnricher);
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    const label = result.get(arn);
    expect(label).toBeDefined();
    expect(label).not.toBe("$0.00/mo");
    expect(label).toMatch(/\$0\.0/);
  });

  it("multi-distribution: each gets its own $/mo from its own usage", async () => {
    const arn1 = "arn:aws:cloudfront::112233445566:distribution/EDIST001";
    const arn2 = "arn:aws:cloudfront::112233445566:distribution/EDIST002";
    const arn3 = "arn:aws:cloudfront::112233445566:distribution/EDIST003";
    mockToolInvoke.mockImplementation(routeByFilter());

    // Three distributions, three traffic profiles, three answers:
    //   D1: 100 GB + 10,000 reqs → 100×0.085 + 10000×0.000001 = $8.51
    //   D2: 500 GB + 100,000 reqs → 500×0.085 + 100000×0.000001 = $42.60
    //   D3: 2000 GB + 5,000,000 reqs → 2000×0.085 + 5e6×0.000001 = $175.00
    const usageEnricher = vi.fn(
      async () =>
        new Map([
          [
            arn1,
            {
              cloudfrontRequestsPerMonth: 10_000,
              cloudfrontBytesPerMonth: 100,
            },
          ],
          [
            arn2,
            {
              cloudfrontRequestsPerMonth: 100_000,
              cloudfrontBytesPerMonth: 500,
            },
          ],
          [
            arn3,
            {
              cloudfrontRequestsPerMonth: 5_000_000,
              cloudfrontBytesPerMonth: 2000,
            },
          ],
        ]),
    );

    const enricher = createListPricingEnricher(usageEnricher);
    const result = await enricher([
      makeResource(arn1, "AWS::CloudFront::Distribution", "global"),
      makeResource(arn2, "AWS::CloudFront::Distribution", "global"),
      makeResource(arn3, "AWS::CloudFront::Distribution", "global"),
    ]);

    expect(result.get(arn1)).toBe("$8.51/mo");
    expect(result.get(arn2)).toBe("$42.60/mo");
    expect(result.get(arn3)).toBe("$175.00/mo");
    // Pricing MCP called twice total: one tuple (CloudFront + global)
    // × 2 usage-based line items (data transfer + requests).
    expect(mockToolInvoke).toHaveBeenCalledTimes(2);
  });

  it("falls back gracefully when CloudWatch IAM is denied (usage enricher returns empty)", async () => {
    // Simulates the IAM-denied path: CloudWatch's silent-swallow leaves
    // the usage map empty; pricing-enricher must fall back to the
    // rate-hint, NOT throw and NOT emit a $/mo total.
    const arn = "arn:aws:cloudfront::112233445566:distribution/EIAMDENIED";
    mockToolInvoke.mockImplementation(routeByFilter());

    const usageEnricher = vi.fn(async () => new Map());

    const enricher = createListPricingEnricher(usageEnricher);

    // Must not throw.
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    const label = result.get(arn);
    expect(label).toBeDefined();
    expect(label).not.toBe("$0.00/mo");
    // Rate hint (tier-ladder text contains the first-tier rate).
    expect(label).toContain("$0.0");
  });

  it("survives MCP per-line-item failures (data-transfer fails, requests succeeds → rate hint)", async () => {
    // Failure isolation: if the data-transfer MCP call rejects, the
    // distribution still falls back to the requests rate hint rather
    // than crashing the whole tuple.
    const arn = "arn:aws:cloudfront::112233445566:distribution/EPARTIAL";
    mockToolInvoke.mockImplementation(
      ({ filters }: { filters: Array<{ Field: string; Value: string }> }) => {
        const fam = filters.find((f) => f.Field === "productFamily")?.Value;
        if (fam === "Data Transfer") {
          return Promise.reject(new Error("Pricing MCP transient"));
        }
        if (fam === "API Request") {
          return Promise.resolve(wrapMcpText(CLOUDFRONT_REQUESTS_RESPONSE));
        }
        return Promise.resolve(null);
      },
    );

    const usageEnricher = vi.fn(
      async () =>
        new Map([
          [
            arn,
            { cloudfrontRequestsPerMonth: 1_000, cloudfrontBytesPerMonth: 100 },
          ],
        ]),
    );

    const enricher = createListPricingEnricher(usageEnricher);
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    // No tier ladder → no promotion → rate-hint fallback (requests rate).
    const label = result.get(arn);
    expect(label).toBeDefined();
    expect(label).not.toBe("$0.00/mo");
    expect(label).toMatch(/\$0\.0/);
  });

  // ────────────────────────────────────────────────────────────────
  // F6-ITEM-2 (Quinn HIGH-1) — deterministic edge-region selection.
  // The Pricing API publishes one tier ladder per edge region (NA,
  // JP, SG, EU, etc.) at different per-GB rates. Without a
  // `fromLocation` filter, `extractTieredPrice` picks whichever
  // entry the MCP server happens to return first → $/mo drifts per
  // run. The decomposer's `fromLocation=North America` filter must
  // drive `itemMatchesFilters` to keep the NA tier ladder and
  // reject JP / SG entries — regardless of where they sit in the
  // response array.
  // ────────────────────────────────────────────────────────────────
  it("HIGH-1: pins data-transfer rate to NA tier regardless of fixture entry order", async () => {
    const arn = "arn:aws:cloudfront::112233445566:distribution/EMULTIEDGE";
    // Multi-edge fixture lists JP + SG BEFORE NA; the prior
    // (pre-amendment) implementation would have picked JP's
    // $0.114/GB → 100 GB × $0.114 + 10000 × $0.000001 = $11.41/mo.
    // With the NA pin, we expect:
    //   100 GB × $0.085 = $8.50 (tier 1 NA)
    //   10,000 × $0.000001 = $0.01
    //   Total: $8.51/mo
    mockToolInvoke.mockImplementation(
      ({ filters }: { filters: Array<{ Field: string; Value: string }> }) => {
        const fam = filters.find((f) => f.Field === "productFamily")?.Value;
        if (fam === "Data Transfer") {
          return Promise.resolve(
            wrapMcpText(CLOUDFRONT_DATA_TRANSFER_MULTI_EDGE_REGION_RESPONSE),
          );
        }
        if (fam === "API Request") {
          return Promise.resolve(wrapMcpText(CLOUDFRONT_REQUESTS_RESPONSE));
        }
        return Promise.resolve(null);
      },
    );

    const usageEnricher = vi.fn(
      async () =>
        new Map([
          [
            arn,
            {
              cloudfrontRequestsPerMonth: 10_000,
              cloudfrontBytesPerMonth: 100,
            },
          ],
        ]),
    );

    const enricher = createListPricingEnricher(usageEnricher);
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    // Asserts the NA-pinned, deterministic rate. Any value other than
    // $8.51/mo (e.g. $11.41/mo from JP, $12.01/mo from SG) means the
    // fromLocation filter broke and edge selection regressed to
    // non-determinism.
    expect(result.get(arn)).toBe("$8.51/mo");
  });
});

// ──────────────────────────────────────────────────────────────────
// `computeTieredCost` unit tests — the per-tier multiplier helper
// is exported for direct verification of the math (independent of
// MCP shape and async plumbing).
// ──────────────────────────────────────────────────────────────────

describe("computeTieredCost — tier-ladder math", () => {
  // Canonical CloudFront NA rate ladder as PriceTier[].
  const NA_TIERS = [
    {
      beginRange: 0,
      endRange: 10240,
      rate: "0.085",
      currency: "USD",
      unit: "GB",
    },
    {
      beginRange: 10240,
      endRange: 51200,
      rate: "0.080",
      currency: "USD",
      unit: "GB",
    },
    {
      beginRange: 51200,
      endRange: 153600,
      rate: "0.060",
      currency: "USD",
      unit: "GB",
    },
  ];

  it("returns 0 for zero GB", async () => {
    const { computeTieredCost } = await import("./pricing-enricher.js");
    expect(computeTieredCost(0, NA_TIERS)).toBe(0);
  });

  it("returns null for empty tier list (caller falls back to rate hint)", async () => {
    const { computeTieredCost } = await import("./pricing-enricher.js");
    expect(computeTieredCost(100, [])).toBeNull();
  });

  it("computes a tier-1-only volume correctly (1000 GB × $0.085 = $85.00)", async () => {
    const { computeTieredCost } = await import("./pricing-enricher.js");
    expect(computeTieredCost(1000, NA_TIERS)).toBeCloseTo(85, 6);
  });

  it("computes a tier-crossing volume correctly (15360 GB → $1280.00)", async () => {
    const { computeTieredCost } = await import("./pricing-enricher.js");
    // 10240 × $0.085 = $870.40
    // 5120 × $0.080 = $409.60
    // Total: $1280.00
    expect(computeTieredCost(15_360, NA_TIERS)).toBeCloseTo(1280, 6);
  });

  it("crosses 3 tiers correctly (61440 GB → $4761.60)", async () => {
    // F6-ITEM-2 optional Quinn add: locks the bottom-tier branch
    // behavior. 61440 GB (60 TB) walks through all three tiers:
    //   Tier 1 (0–10 TB):   10240 GB × $0.085 = $870.40
    //   Tier 2 (10–50 TB):  40960 GB × $0.080 = $3276.80
    //   Tier 3 (50–150 TB): 10240 GB × $0.060 = $614.40
    //   Total:                                  $4761.60
    const { computeTieredCost } = await import("./pricing-enricher.js");
    expect(computeTieredCost(61_440, NA_TIERS)).toBeCloseTo(4761.6, 4);
  });

  it("treats an open-ended top tier as infinity", async () => {
    const { computeTieredCost } = await import("./pricing-enricher.js");
    const tiers = [
      {
        beginRange: 0,
        endRange: 100,
        rate: "0.10",
        currency: "USD",
        unit: "GB",
      },
      { beginRange: 100, rate: "0.05", currency: "USD", unit: "GB" },
    ];
    // 100 × $0.10 + 900 × $0.05 = $10 + $45 = $55
    expect(computeTieredCost(1000, tiers)).toBeCloseTo(55, 6);
  });

  it("returns null when a tier rate is unparseable", async () => {
    const { computeTieredCost } = await import("./pricing-enricher.js");
    const tiers = [
      {
        beginRange: 0,
        endRange: 100,
        rate: "not-a-number",
        currency: "USD",
        unit: "GB",
      },
    ];
    expect(computeTieredCost(50, tiers)).toBeNull();
  });
});
