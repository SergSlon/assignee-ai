/**
 * Unit tests for breakdown.ts bounded-concurrency pricing fan-out (M-α-21 / W13-S3).
 *
 * Covers:
 * 1. Max concurrency ≤ PRICING_CONCURRENCY for a 12-item input.
 * 2. Partial-failure isolation: one bad fetch does not abort the other items.
 * 3. All items fail → all results "unavailable"; hasPartialFailure = true.
 * 4. Zero line items → empty arrays, no errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import {
  PRICING_CONCURRENCY,
  queryLineItemPrices,
  _resetPricingClientForTesting,
} from "./breakdown.js";
import type { PricingLineItem } from "@/index.js";
import { ToolName } from "@/constants/tools.js";

// ─── Silence price-cache filesystem I/O ─────────────────────────────────────
vi.mock("@/services/price-cache.js", () => ({
  getCachedPrice: vi.fn(() => null),
  setCachedPrice: vi.fn(),
}));

// ─── Hoisted spies for the SDK bypass describe-block ─────────────────────────
// `vi.hoisted` runs BEFORE module imports, so we can reference the spies
// inside `vi.mock` factories below (which also hoist) without TDZ errors.
const { mockPricingClientSend, mockRequireAssigneeCredentials, mockLog } =
  vi.hoisted(() => ({
    mockPricingClientSend: vi.fn(),
    mockRequireAssigneeCredentials: vi.fn(),
    mockLog: vi.fn(),
  }));

// Mock the AWS Pricing SDK so the SDK bypass branch hits an in-process stub.
// The `send` impl is reassigned per-test via `mockPricingClientSend.mockImpl…`.
vi.mock("@aws-sdk/client-pricing", () => {
  class FakePricingClient {
    constructor(public readonly options: unknown) {}
    send(command: unknown): unknown {
      return mockPricingClientSend(command, this.options);
    }
  }
  // GetProductsCommand is constructed but only its `.input` is read by the
  // mocked send. Provide a tiny shim that captures the input on `.input`.
  class FakeGetProductsCommand {
    constructor(public readonly input: unknown) {}
  }
  return {
    PricingClient: FakePricingClient,
    GetProductsCommand: FakeGetProductsCommand,
  };
});

// Mock requireAssigneeCredentials so we can both spy on the call AND inject
// the failure-path behaviour. By default returns a real-shape ASIA* STS
// credential triplet — placeholder values from
// `feedback_no_real_account_ids_in_repo` (test secrets only).
vi.mock("@/config/aws-credentials.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/config/aws-credentials.js")>();
  return {
    ...actual,
    requireAssigneeCredentials: mockRequireAssigneeCredentials,
  };
});

// Mock logger so the negative-path test can assert that the previously-
// silent catch now emits a structured WARN with the AWS error message.
vi.mock("@/utils/logger/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/logger/index.js")>();
  return {
    ...actual,
    log: mockLog,
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal AwsPricingResponse wrapped in MCP text envelope. */
function mcpPricingText(priceUsd: string): { type: "text"; text: string } {
  const sku = "TESTSKU001";
  return {
    type: "text",
    text: JSON.stringify({
      status: "success",
      service_name: "AmazonEC2",
      data: [
        {
          product: {
            productFamily: "Compute Instance",
            attributes: {
              regionCode: "us-east-1",
              servicecode: "AmazonEC2",
              instanceType: "t3.small",
              operatingSystem: "Linux",
              preInstalledSw: "NA",
              tenancy: "Shared",
              capacitystatus: "Used",
              licenseModel: "No License required",
            },
            sku,
          },
          terms: {
            OnDemand: {
              [`${sku}.JRTCKXETXF`]: {
                priceDimensions: {
                  [`${sku}.JRTCKXETXF.6YS6EN2CT7`]: {
                    unit: "Hrs",
                    endRange: "Inf",
                    description: "Linux On Demand Instance",
                    appliesTo: [],
                    rateCode: `${sku}.JRTCKXETXF.6YS6EN2CT7`,
                    beginRange: "0",
                    pricePerUnit: { USD: priceUsd },
                  },
                },
                sku,
                effectiveDate: "2026-03-01T00:00:00Z",
                offerTermCode: "JRTCKXETXF",
                termAttributes: {},
              },
            },
          },
          version: "20260223232215",
          publicationDate: "2026-02-23T23:22:15Z",
        },
      ],
      message: "Retrieved pricing from AWS Pricing API",
    }),
  };
}

/** Build a minimal fixed-kind PricingLineItem. */
function makeLineItem(index: number): PricingLineItem {
  return {
    label: `Compute ${index}`,
    quantity: 1,
    unit: "hours",
    serviceCode: "AmazonEC2",
    filters: [
      { Field: "instanceType", Value: "t3.small", Type: "TERM_MATCH" },
      { Field: "operatingSystem", Value: "Linux", Type: "TERM_MATCH" },
    ],
    kind: "fixed" as const,
    description: `t3.small #${index}`,
    priceUnit: "/hr",
  };
}

/** Build a mock StructuredTool that resolves with the given response. */
function makePricingTool(
  invokeFn: (input: unknown) => Promise<unknown>,
): StructuredTool {
  return {
    name: ToolName.GET_PRICING,
    invoke: invokeFn,
  } as unknown as StructuredTool;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PRICING_CONCURRENCY constant", () => {
  it("is exported and equals 5", () => {
    expect(PRICING_CONCURRENCY).toBe(5);
  });
});

describe("queryLineItemPrices — bounded concurrency", () => {
  it("never exceeds PRICING_CONCURRENCY concurrent calls for a 12-item input", async () => {
    const lineItems = Array.from({ length: 12 }, (_, i) => makeLineItem(i));

    let inFlight = 0;
    let maxInFlight = 0;

    // Each call increments counter, waits briefly, then decrements.
    const invokeFn = async (_input: unknown): Promise<unknown> => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Yield once to let other microtasks/promises queue up
      await Promise.resolve();
      inFlight--;
      return mcpPricingText("0.0416000000");
    };

    const tool = makePricingTool(invokeFn);
    const breakdown = await queryLineItemPrices(lineItems, [tool], "run-1");

    expect(maxInFlight).toBeLessThanOrEqual(PRICING_CONCURRENCY);
    expect(breakdown.fixedItems).toHaveLength(12);
  });

  it("processes all items in stable order", async () => {
    const count = 12;
    const lineItems = Array.from({ length: count }, (_, i) => makeLineItem(i));

    const invokeFn = async (_input: unknown): Promise<unknown> => {
      return mcpPricingText("0.0416000000");
    };

    const tool = makePricingTool(invokeFn);
    const breakdown = await queryLineItemPrices(lineItems, [tool], "run-order");

    // Results must preserve input ordering
    for (let i = 0; i < count; i++) {
      expect(breakdown.fixedItems[i]?.lineItem.label).toBe(`Compute ${i}`);
    }
  });
});

describe("queryLineItemPrices — partial-failure isolation", () => {
  it("one failing item does not abort remaining items; hasPartialFailure=true", async () => {
    const lineItems = Array.from({ length: 5 }, (_, i) => makeLineItem(i));

    // Item index 2 throws; others succeed.
    let callCount = 0;
    const invokeFn = async (_input: unknown): Promise<unknown> => {
      const index = callCount++;
      if (index === 2) {
        throw new Error("HTTP 429 Too Many Requests");
      }
      return mcpPricingText("0.0416000000");
    };

    const tool = makePricingTool(invokeFn);
    const breakdown = await queryLineItemPrices(
      lineItems,
      [tool],
      "run-partial",
    );

    expect(breakdown.hasPartialFailure).toBe(true);
    // All 5 items must be present (none dropped)
    expect(breakdown.fixedItems).toHaveLength(5);
    // Item 2 is "unavailable"; all others have a real price
    const unavailableItems = breakdown.fixedItems.filter(
      (r) => r.displayPrice === "unavailable",
    );
    const priceItems = breakdown.fixedItems.filter(
      (r) => r.displayPrice !== "unavailable",
    );
    expect(unavailableItems).toHaveLength(1);
    expect(priceItems).toHaveLength(4);
    expect(unavailableItems[0]?.lineItem.label).toBe("Compute 2");
  });

  it("all items failing → all results unavailable; hasPartialFailure=true", async () => {
    const lineItems = Array.from({ length: 3 }, (_, i) => makeLineItem(i));

    const invokeFn = async (_input: unknown): Promise<unknown> => {
      throw new Error("Service unavailable");
    };

    const tool = makePricingTool(invokeFn);
    const breakdown = await queryLineItemPrices(
      lineItems,
      [tool],
      "run-all-fail",
    );

    expect(breakdown.hasPartialFailure).toBe(true);
    expect(breakdown.fixedItems).toHaveLength(3);
    expect(
      breakdown.fixedItems.every((r) => r.displayPrice === "unavailable"),
    ).toBe(true);
    expect(
      breakdown.fixedItems.every(
        (r) => r.unitPrice === null && r.monthlyCost === null,
      ),
    ).toBe(true);
  });
});

describe("queryLineItemPrices — edge cases", () => {
  it("zero line items → empty breakdown with no errors", async () => {
    const tool = makePricingTool(async () => mcpPricingText("0.0416000000"));
    const breakdown = await queryLineItemPrices([], [tool], "run-empty");

    expect(breakdown.fixedItems).toHaveLength(0);
    expect(breakdown.usageBasedItems).toHaveLength(0);
    expect(breakdown.hasPartialFailure).toBe(false);
    expect(breakdown.hasCacheHits).toBe(false);
    expect(breakdown.fixedSubtotal).toBe(0);
  });

  it("no pricing tool → all items unavailable; hasPartialFailure=true", async () => {
    const lineItems = Array.from({ length: 3 }, (_, i) => makeLineItem(i));

    // Pass an empty tools array so pricingTool is undefined
    const breakdown = await queryLineItemPrices(lineItems, [], "run-notool");

    expect(breakdown.hasPartialFailure).toBe(true);
    expect(breakdown.fixedItems).toHaveLength(3);
    expect(
      breakdown.fixedItems.every((r) => r.displayPrice === "unavailable"),
    ).toBe(true);
  });
});

describe("queryLineItemPrices — AWSDataTransfer fromRegionCode injection", () => {
  // Bug: S3 / EC2 / API Gateway data-transfer-out lines were rendering as
  // `unavailable` because the AWSDataTransfer service code returns rows
  // for EVERY region (us-east-1, us-east-2, eu-west-1, …) when the
  // request doesn't filter by `fromRegionCode`. The MCP tool's `region`
  // parameter does NOT scope the filter for AWSDataTransfer (it does
  // for service-specific codes like AmazonS3 / AmazonEC2). This block
  // verifies breakdown.ts injects `fromRegionCode=<AWS_REGION>` into
  // any AWSDataTransfer request that doesn't already specify it.
  it("injects fromRegionCode=<region> for AWSDataTransfer requests", async () => {
    const captured: Array<{
      filters: ReadonlyArray<{ Field: string; Value: string; Type: string }>;
    }> = [];
    const tool = makePricingTool(async (input) => {
      captured.push(
        input as {
          filters: ReadonlyArray<{
            Field: string;
            Value: string;
            Type: string;
          }>;
        },
      );
      return mcpPricingText("0.0900000000");
    });

    const dataTransferItem: PricingLineItem = {
      label: "Data transfer out",
      quantity: 0,
      unit: "GB",
      serviceCode: "AWSDataTransfer",
      filters: [
        { Field: "productFamily", Value: "Data Transfer", Type: "TERM_MATCH" },
        { Field: "transferType", Value: "AWS Outbound", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per GB",
      priceUnit: "per GB",
    };

    await queryLineItemPrices([dataTransferItem], [tool], "run-dtx");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.filters.some((f) => f.Field === "fromRegionCode")).toBe(
      true,
    );
  });

  it("does NOT mutate filters for non-AWSDataTransfer service codes", async () => {
    const captured: Array<{
      filters: ReadonlyArray<{ Field: string; Value: string; Type: string }>;
    }> = [];
    const tool = makePricingTool(async (input) => {
      captured.push(
        input as {
          filters: ReadonlyArray<{
            Field: string;
            Value: string;
            Type: string;
          }>;
        },
      );
      return mcpPricingText("0.0230000000");
    });

    const s3StorageItem: PricingLineItem = {
      label: "Storage",
      quantity: 0,
      unit: "GB",
      serviceCode: "AmazonS3",
      filters: [
        { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per GB-month",
      priceUnit: "per GB-month",
    };

    await queryLineItemPrices([s3StorageItem], [tool], "run-s3");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.filters.some((f) => f.Field === "fromRegionCode")).toBe(
      false,
    );
  });

  it("preserves an existing fromRegionCode filter (idempotent)", async () => {
    const captured: Array<{
      filters: ReadonlyArray<{ Field: string; Value: string; Type: string }>;
    }> = [];
    const tool = makePricingTool(async (input) => {
      captured.push(
        input as {
          filters: ReadonlyArray<{
            Field: string;
            Value: string;
            Type: string;
          }>;
        },
      );
      return mcpPricingText("0.0900000000");
    });

    const dataTransferItem: PricingLineItem = {
      label: "Data transfer out",
      quantity: 0,
      unit: "GB",
      serviceCode: "AWSDataTransfer",
      filters: [
        { Field: "fromRegionCode", Value: "eu-west-1", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per GB",
      priceUnit: "per GB",
    };

    await queryLineItemPrices([dataTransferItem], [tool], "run-dtx-prefilled");

    expect(captured).toHaveLength(1);
    const fromRegion = captured[0]!.filters.filter(
      (f) => f.Field === "fromRegionCode",
    );
    expect(fromRegion).toHaveLength(1);
    // Pre-existing value preserved, not overwritten with AWS_REGION
    expect(fromRegion[0]!.Value).toBe("eu-west-1");
  });
});

// ─── SDK bypass branch coverage ──────────────────────────────────────────────
//
// Regression: `breakdown.ts` routes `AWSDataTransfer` queries directly through
// `@aws-sdk/client-pricing` (the awslabs Pricing MCP cannot service them
// reliably). The factory previously constructed `new PricingClient({ region })`
// with NO credentials field, so in production — where the CLI command-runner
// renames AWS_* to ASSIGNEE_OPERATOR_* before any command runs — the standard
// SDK provider chain found nothing to use, threw an auth error, and the bare
// `catch {}` swallowed it. Result: every S3 / EC2 / API Gateway data-transfer-
// out line rendered as `displayPrice: "unavailable"` even when the operator
// had perfectly valid creds.
//
// This block exercises the SDK bypass branch by:
//   (a) Forcing the gate via the env-var dance (delete `process.env.VITEST`
//       in beforeEach, restore in afterEach). The branch is otherwise
//       unreachable from vitest workers because `isVitestEnvironment()`
//       short-circuits to `false`.
//   (b) Mocking `@aws-sdk/client-pricing` so `PricingClient.send` is an
//       in-process stub returning a real-shape `GetProducts` response.
//   (c) Mocking `requireAssigneeCredentials` so we can spy on the call AND
//       force the negative path by throwing a `MissingAssigneeCredentialsError`.
//   (d) Asserting the new `LOG_ACTIONS.PRICING_SDK_BYPASS_FAILED` warning
//       is emitted when credential resolution / SDK call fails.
describe("queryLineItemPrices — SDK bypass for AWSDataTransfer", () => {
  let originalVitest: string | undefined;

  beforeEach(() => {
    originalVitest = process.env["VITEST"];
    delete process.env["VITEST"];
    _resetPricingClientForTesting();
    mockPricingClientSend.mockReset();
    mockRequireAssigneeCredentials.mockReset();
    mockLog.mockReset();

    // Default: real-shape ASIA* STS credential triplet. ASIA prefix denotes
    // a temporary STS session (per `aws-credentials.ts:93`); accessKeyId /
    // secretAccessKey lengths match what AWS actually issues. Test fixture
    // — never used against real AWS.
    mockRequireAssigneeCredentials.mockReturnValue({
      accessKeyId: "ASIATESTACCESSKEY00",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken:
        "FQoGZXIvYXdzEC0aDExampleSessionTokenValueForTestingOnly0123456789".repeat(
          3,
        ),
    });
  });

  afterEach(() => {
    if (originalVitest !== undefined) {
      process.env["VITEST"] = originalVitest;
    } else {
      delete process.env["VITEST"];
    }
    _resetPricingClientForTesting();
  });

  /**
   * Build a real-shape AWSDataTransfer line item matching what
   * `s3.ts:101-127` emits — same productFamily / transferType /
   * fromLocationType / toLocationType filter set the production
   * decomposer registers.
   */
  function makeDataTransferItem(): PricingLineItem {
    return {
      label: "Data transfer out",
      quantity: 0,
      unit: "GB",
      serviceCode: "AWSDataTransfer",
      filters: [
        { Field: "productFamily", Value: "Data Transfer", Type: "TERM_MATCH" },
        { Field: "fromLocationType", Value: "AWS Region", Type: "TERM_MATCH" },
        { Field: "toLocationType", Value: "Other", Type: "TERM_MATCH" },
        { Field: "transferType", Value: "AWS Outbound", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per GB",
      priceUnit: "per GB",
    };
  }

  /**
   * Build a real-shape `GetProducts` response. Mirrors the actual
   * AWS Pricing API JSON shape (productFamily=Data Transfer, AWS
   * Outbound, single tier $0.09/GB). PriceList is returned as an
   * array of LazyJsonString-style wrappers — `breakdown.ts:117-126`
   * handles that branch via `entry.deserializeJSON()`.
   */
  function buildGetProductsResponse(priceUsd: string): {
    PriceList: Array<{ deserializeJSON: () => unknown }>;
  } {
    const sku = "DTOSKU0001";
    const product = {
      product: {
        productFamily: "Data Transfer",
        attributes: {
          servicecode: "AWSDataTransfer",
          servicename: "AWS Data Transfer",
          regionCode: "us-east-1",
          fromLocationType: "AWS Region",
          fromRegionCode: "us-east-1",
          toLocationType: "Other",
          transferType: "AWS Outbound",
          usagetype: "DataTransfer-Out-Bytes",
        },
        sku,
      },
      terms: {
        OnDemand: {
          [`${sku}.JRTCKXETXF`]: {
            priceDimensions: {
              [`${sku}.JRTCKXETXF.6YS6EN2CT7`]: {
                unit: "GB",
                endRange: "Inf",
                description: `$${priceUsd} per GB - first 10 TB / month data transfer out`,
                appliesTo: [],
                rateCode: `${sku}.JRTCKXETXF.6YS6EN2CT7`,
                beginRange: "0",
                pricePerUnit: { USD: priceUsd },
              },
            },
            sku,
            effectiveDate: "2026-04-01T00:00:00Z",
            offerTermCode: "JRTCKXETXF",
            termAttributes: {},
          },
        },
      },
      version: "20260420",
      publicationDate: "2026-04-20T00:00:00Z",
    };
    return {
      PriceList: [{ deserializeJSON: () => product }],
    };
  }

  /**
   * Build a pricing tool whose `.invoke()` is poisoned: if it is ever
   * called we fail loudly. This proves the SDK bypass branch — not the
   * MCP branch — produced the result. The tool MUST be present in the
   * tools array because `breakdown.ts:226-234` early-returns
   * `unavailable` when no `GET_PRICING` tool is registered (this guard
   * is upstream of the bypass-vs-MCP routing decision).
   */
  function makePoisonedPricingTool(): StructuredTool {
    return makePricingTool(async () => {
      throw new Error(
        "MCP pricingTool.invoke() must NOT be called when SDK bypass is in effect",
      );
    });
  }

  it("happy path: resolves reader credentials, calls PricingClient.send, returns real numeric rate (NOT unavailable)", async () => {
    mockPricingClientSend.mockResolvedValueOnce(
      buildGetProductsResponse("0.0900000000"),
    );

    const breakdown = await queryLineItemPrices(
      [makeDataTransferItem()],
      // Tool MUST be present so the upstream guard doesn't short-circuit
      // before bypass routing. The poisoned `.invoke()` proves the SDK
      // bypass produced the result rather than the MCP path.
      [makePoisonedPricingTool()],
      "run-sdk-bypass-happy",
    );

    // Assertion 1: credential provider was actually invoked. This is the
    // load-bearing assertion — the regression was that creds were NEVER
    // resolved, so the SDK threw an auth error.
    //
    // Reader role is the correct role for this call (Layer 2 fix
    // 2026-05-09). The operator IAM policy does NOT grant `pricing:*` —
    // only the reader policy does (see iam-policies/reader.ts:39-47).
    // Passing "operator" here would silently fail in production with
    // an AccessDenied — which is exactly the regression that motivated
    // the role swap.
    expect(mockRequireAssigneeCredentials).toHaveBeenCalledWith("reader");
    expect(mockRequireAssigneeCredentials).toHaveBeenCalledTimes(1);

    // Assertion 2: PricingClient.send was called with the AWSDataTransfer
    // service code and the post-injection filter shape (fromRegionCode added).
    expect(mockPricingClientSend).toHaveBeenCalledTimes(1);
    const sentCommand = mockPricingClientSend.mock.calls[0]![0] as {
      input: { ServiceCode: string; Filters: Array<{ Field: string }> };
    };
    expect(sentCommand.input.ServiceCode).toBe("AWSDataTransfer");
    expect(
      sentCommand.input.Filters.some(
        (f: { Field: string }) => f.Field === "fromRegionCode",
      ),
    ).toBe(true);

    // Assertion 3: the AWSDataTransfer line resolves to a real rate, NOT
    // `unavailable`. This is the regression assertion: pre-fix, every
    // production AWSDataTransfer line rendered "unavailable" silently.
    expect(breakdown.usageBasedItems).toHaveLength(1);
    const item = breakdown.usageBasedItems[0]!;
    expect(item.displayPrice).not.toBe("unavailable");
    // unitPrice is the parser's "$<value><unit>" rendering for the
    // first-tier flat-rate path. priceUnit on the line item is "per GB"
    // (mirrors `s3.ts:127`), so the parser yields "$0.0900per GB" — a
    // real production string, asserted as-is rather than reshaped.
    expect(item.unitPrice).toBe("$0.0900per GB");
    expect(breakdown.hasPartialFailure).toBe(false);
  });

  it("negative path: when credential provider throws, error is logged via PRICING_SDK_BYPASS_FAILED and result is unavailable", async () => {
    // Simulate the production failure mode: command-runner renamed AWS_*
    // to ASSIGNEE_READER_* but the user's env had no credentials at all,
    // so requireAssigneeCredentials throws. Pre-fix this got swallowed by
    // the bare `catch {}` and surfaced as a silent `unavailable`.
    //
    // Error string mirrors the real production error built by
    // `requireAssigneeCredentials("reader")` (see aws-credentials.ts:50)
    // which interpolates the role name into the "Missing <role>
    // credentials" message and the env-var names.
    const authError = new Error(
      "Missing reader credentials. Set ASSIGNEE_READER_ACCESS_KEY_ID and ASSIGNEE_READER_SECRET_ACCESS_KEY",
    );
    mockRequireAssigneeCredentials.mockImplementationOnce(() => {
      throw authError;
    });

    const breakdown = await queryLineItemPrices(
      [makeDataTransferItem()],
      [makePoisonedPricingTool()],
      "run-sdk-bypass-auth-fail",
    );

    // Assertion 1: result IS unavailable (control flow preserved).
    expect(breakdown.usageBasedItems).toHaveLength(1);
    expect(breakdown.usageBasedItems[0]!.displayPrice).toBe("unavailable");
    expect(breakdown.hasPartialFailure).toBe(true);

    // Assertion 2: the error is now LOGGED — this is the new observability
    // landing from Change 2 (replacing the bare `catch {}`).
    const sdkBypassFailedCalls = mockLog.mock.calls.filter(
      (call) =>
        (call[0] as { action: string }).action === "pricing_sdk_bypass_failed",
    );
    expect(sdkBypassFailedCalls).toHaveLength(1);
    const event = sdkBypassFailedCalls[0]![0] as {
      action: string;
      level: string;
      extras?: { serviceCode?: string; error?: string };
    };
    expect(event.level).toBe("warn");
    expect(event.extras?.serviceCode).toBe("AWSDataTransfer");
    expect(event.extras?.error).toContain("Missing reader credentials");

    // Assertion 3: the SDK send was never called (auth failed first).
    expect(mockPricingClientSend).not.toHaveBeenCalled();
  });

  it("negative path: when SDK send throws (upstream API error), error is logged and result is unavailable", async () => {
    // Operator creds resolve cleanly but the upstream Pricing API is sad —
    // common shape is a `ThrottlingException` or `InternalServerError`.
    // Both must land in the new structured warning.
    const upstreamError = new Error(
      "ThrottlingException: Rate exceeded for GetProducts",
    );
    mockPricingClientSend.mockRejectedValueOnce(upstreamError);

    const breakdown = await queryLineItemPrices(
      [makeDataTransferItem()],
      [makePoisonedPricingTool()],
      "run-sdk-bypass-throttle",
    );

    expect(breakdown.usageBasedItems[0]!.displayPrice).toBe("unavailable");
    expect(breakdown.hasPartialFailure).toBe(true);

    const sdkBypassFailedCalls = mockLog.mock.calls.filter(
      (call) =>
        (call[0] as { action: string }).action === "pricing_sdk_bypass_failed",
    );
    expect(sdkBypassFailedCalls).toHaveLength(1);
    const event = sdkBypassFailedCalls[0]![0] as {
      extras?: { error?: string };
    };
    expect(event.extras?.error).toContain("ThrottlingException");

    // Credential resolution succeeded (called once), then the SDK threw.
    expect(mockRequireAssigneeCredentials).toHaveBeenCalledTimes(1);
    expect(mockPricingClientSend).toHaveBeenCalledTimes(1);
  });
});
