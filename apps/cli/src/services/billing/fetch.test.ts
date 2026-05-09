/**
 * Epic 92 Wave 4 (e92.4.a) — savings-formatter sanitation tests.
 *
 * Complements the legacy suite in `apps/cli/src/services/billing.test.ts`
 * which tests the happy-path wiring. This file pins display-side behavior
 * for the three sanitation buckets (A-08, B-21, D-15, D-18) and also
 * pins SNS + DDB billing-map output to raw MCP response strings (A-10).
 *
 * All mocks use captured MCP fixtures — no synthetic placeholder values.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CostEstimateLabel } from "@assignee/core";
import {
  fetchBillingData,
  formatSavingsDisplay,
  getCostSavingsEstimate,
} from "./fetch.js";
import type { ManagedResource } from "../list-resources.js";
import {
  McpMocks,
  createBillingMockTool,
} from "../../test-fixtures/mcp-mock-responses.js";

vi.mock("../memory.js", () => ({
  defaultMemoryService: {
    readProvisions: vi.fn().mockResolvedValue([]),
  },
}));

// ── @assignee/core: real CostEstimateLabel, stubbed createListPricingEnricher ──
//
// Defect 3 regression-guard (2026-05-09): the production code in
// `getCostSavingsEstimate` calls `createListPricingEnricher()` (re-exported
// from `@assignee/core`, defined in
// `packages/core/src/list-resources/pricing-enricher.ts`) when the
// cost-explorer MCP and provision-log fallback are both silent AND a
// resourceType is threaded through. By identity-mocking the enricher we
// (a) remove the live-MCP coupling that previously forced the test's
// alternation regex to accept the "No cost savings" fallback and
// (b) gain a single explicit assertion site that proves the decomposer
// path is on. If the production code regresses to passing
// `UNKNOWN_FALLBACK` (skipping the decomposer branch), the
// `toHaveBeenCalledTimes(1)` assertion fires and the test goes red.
const mockEnricher = vi.fn();
vi.mock("@assignee/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@assignee/core")>();
  return {
    ...real,
    createListPricingEnricher: () => mockEnricher,
  };
});

import { defaultMemoryService } from "../memory.js";
const mockReadProvisions = vi.mocked(defaultMemoryService.readProvisions);

describe("formatSavingsDisplay (Epic 92 Wave 4.a)", () => {
  describe("bucket 1: parseable dollar amount → '{cost} saved'", () => {
    it("formats $X.XX/month", () => {
      expect(formatSavingsDisplay("$0.02/month")).toBe("$0.02/month saved");
    });

    it("formats $X.XX/mo abbreviation", () => {
      expect(formatSavingsDisplay("$3.00/mo")).toBe("$3.00/mo saved");
    });

    it("formats ~$XX.XX/mo approximate prefix", () => {
      expect(formatSavingsDisplay("~$32.85/mo")).toBe("~$32.85/mo saved");
    });

    it("formats integer-only $N/mo", () => {
      expect(formatSavingsDisplay("$5/mo")).toBe("$5/mo saved");
    });

    it("formats cent-precision $X.XX/GB-month", () => {
      expect(formatSavingsDisplay("$0.0230/GB-month")).toBe(
        "$0.0230/GB-month saved",
      );
    });
  });

  describe("bucket 2: Free / No charge → 'Free, $0.00 savings' (B-21 + D-18)", () => {
    it("formats CostEstimateLabel.FREE", () => {
      expect(formatSavingsDisplay(CostEstimateLabel.FREE)).toBe(
        "Free, $0.00 savings",
      );
    });

    it("formats CostEstimateLabel.NO_CHARGE", () => {
      expect(formatSavingsDisplay(CostEstimateLabel.NO_CHARGE)).toBe(
        "Free, $0.00 savings",
      );
    });

    it("uses CostEstimateLabel.FREE as the source of truth (not a literal)", () => {
      expect(CostEstimateLabel.FREE).toBe("Free");
      expect(CostEstimateLabel.NO_CHARGE).toBe("No charge");
    });
  });

  describe("bucket 3: non-parseable labels → 'No cost savings' (A-08 + D-15)", () => {
    it("formats CostEstimateLabel.NA", () => {
      expect(formatSavingsDisplay(CostEstimateLabel.NA)).toBe(
        "No cost savings",
      );
    });

    it("formats SQS standard-queue per-request label", () => {
      expect(formatSavingsDisplay("Per-request pricing (standard queue)")).toBe(
        "No cost savings",
      );
    });

    it("formats SQS FIFO-queue per-request label", () => {
      expect(formatSavingsDisplay("Per-request pricing (FIFO queue)")).toBe(
        "No cost savings",
      );
    });

    it("formats per-GB pricing label", () => {
      expect(formatSavingsDisplay("Per-GB pricing")).toBe("No cost savings");
    });

    it("formats empty string as no-savings", () => {
      expect(formatSavingsDisplay("")).toBe("No cost savings");
    });
  });
});

const s3Resource: ManagedResource = {
  resourceType: "AWS::S3::Bucket",
  arn: "arn:aws:s3:::my-assignee-bucket-20260322",
  region: "us-east-1",
  createdDate: "2026-03-22",
  estimatedMonthlyCost: "N/A",
};

describe("getCostSavingsEstimate (Epic 92 Wave 4.a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProvisions.mockResolvedValue([]);
    // Default: enricher returns no labels (resource has no decomposer).
    // Tests that exercise the decomposer fallback override per-call.
    mockEnricher.mockResolvedValue(new Map<string, string>());
  });

  it("returns '{cost} saved' when MCP returns parseable dollar amount", async () => {
    const tools = [
      createBillingMockTool(McpMocks.billing.s3BucketCost.success),
    ];
    const result = await getCostSavingsEstimate(s3Resource.arn, tools);
    expect(result).toBe("$0.02/month saved");
  });

  it("returns 'Free, $0.00 savings' when provision-log stored CostEstimateLabel.FREE (B-21)", async () => {
    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000010",
        resourceType: "AWS::EC2::SecurityGroup",
        resourceArn: s3Resource.arn,
        region: "us-east-1",
        desiredStateHash: "free-resource",
        estimatedMonthlyCost: CostEstimateLabel.FREE,
        timestamp: "2026-04-15T00:00:00.000Z",
      },
    ]);
    const result = await getCostSavingsEstimate(s3Resource.arn);
    expect(result).toBe("Free, $0.00 savings");
  });

  it("returns 'Free, $0.00 savings' when provision-log stored 'No charge' (D-18)", async () => {
    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000011",
        resourceType: "AWS::SSM::Parameter",
        resourceArn: s3Resource.arn,
        region: "us-east-1",
        desiredStateHash: "ssm-param",
        estimatedMonthlyCost: CostEstimateLabel.NO_CHARGE,
        timestamp: "2026-04-15T00:00:00.000Z",
      },
    ]);
    const result = await getCostSavingsEstimate(s3Resource.arn);
    expect(result).toBe("Free, $0.00 savings");
  });

  it("returns 'No cost savings' when provision-log stored 'Per-request pricing' label (A-08)", async () => {
    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000012",
        resourceType: "AWS::SQS::Queue",
        resourceArn: s3Resource.arn,
        region: "us-east-1",
        desiredStateHash: "sqs-standard",
        estimatedMonthlyCost: "Per-request pricing (standard queue)",
        timestamp: "2026-04-15T00:00:00.000Z",
      },
    ]);
    const result = await getCostSavingsEstimate(s3Resource.arn);
    expect(result).toBe("No cost savings");
  });

  it("returns 'No cost savings' when MCP + provision-log both empty (A-08/D-15)", async () => {
    const result = await getCostSavingsEstimate(s3Resource.arn);
    expect(result).toBe("No cost savings");
  });

  // ── Defect 3 (2026-05-09): decomposer-registry fallback ──────────────
  //
  // When cost-explorer + provision-log are both silent AND the caller
  // threads a known resourceType, the estimator must reach into the
  // per-type pricing decomposer registry (the same path
  // `assignee list` uses to render `$1.00/mo` for a fresh KMS key).
  // The previous code passed `UNKNOWN_FALLBACK` which bypassed the
  // decomposer and returned "No cost savings", contradicting the
  // freshly-rendered `$1.00/mo` in the list table moments earlier.

  it("Defect 3: returns a decomposer-driven label for KMS when MCP + provision-log are both silent and resourceType is known", async () => {
    // No MCP tools → falls through to provision-log fallback (also empty).
    // resourceType = "AWS::KMS::Key" enables the decomposer fallback.
    const kmsArn =
      "arn:aws:kms:us-east-1:112233445566:key/abc-1234-5678-90ab-cdef-deadbeef00";

    // Stub the enricher to return a real KMS-shaped label. The literal
    // value here is a captured representative of what the live KMS
    // decomposer renders ("$1.00/mo" — see `packages/core/src/pricing/
    // decomposers/kms-key.ts` and the KMS list-table rendering). It is
    // NOT a price lookup: the production code re-derives this value at
    // runtime via `createListPricingEnricher()`, which the live MCP
    // wires up. Per real-data-mocks rule, the shape mirrors what the
    // production enricher actually produces (Map<arn, "$X.XX/mo">).
    mockEnricher.mockResolvedValue(new Map([[kmsArn, "$1.00/mo"]]));

    const result = await getCostSavingsEstimate(kmsArn, "AWS::KMS::Key");

    // ── Assertion 1: enricher was called exactly once with the right payload ──
    // If the production code regresses to threading `UNKNOWN_FALLBACK`
    // (the pre-Defect-3 behaviour), the decomposer branch is skipped
    // entirely and this expectation fails immediately.
    expect(mockEnricher).toHaveBeenCalledTimes(1);
    const enricherCallArgs = mockEnricher.mock.calls[0]!;
    expect(enricherCallArgs).toHaveLength(1);
    const enricherPayload = enricherCallArgs[0] as ManagedResource[];
    expect(enricherPayload).toHaveLength(1);
    expect(enricherPayload[0]).toMatchObject({
      arn: kmsArn,
      resourceType: "AWS::KMS::Key",
    });

    // ── Assertion 2: stricter positive output shape ──
    // Reviewer flagged the previous alternation regex as theatrical: it
    // accepted "No cost savings" so a silent regression to the fallback
    // path would still pass. The new assertion REQUIRES a real $X.XX
    // numeric amount followed by `/mo` (or `/month`) and the literal
    // " saved" suffix, AND explicitly excludes the no-savings fallback
    // substring. If the code regresses to "No cost savings", this test
    // fails — exactly the regression-guard intent.
    expect(typeof result).toBe("string");
    expect(result).toMatch(/\$\d+\.\d+\/m\w+ saved/);
    expect(result).not.toContain("No cost savings");
    expect(result).not.toContain("Free, $0.00 savings");
  });

  it("Defect 3: backwards-compatible 2-arg form still works (legacy callers pass `(arn, mcpTools)`)", async () => {
    // Legacy 2-arg form with mcpTools array — must NOT trigger the
    // decomposer fallback (no resourceType passed) so the result is
    // "No cost savings" when MCP + provision-log are silent.
    const result = await getCostSavingsEstimate(s3Resource.arn, []);
    expect(result).toBe("No cost savings");
  });

  it("Defect 3: backwards-compatible 1-arg form still works", async () => {
    const result = await getCostSavingsEstimate(s3Resource.arn);
    expect(result).toBe("No cost savings");
  });

  it("Defect 3: 3-arg form (arn, resourceType, mcpTools) preserves MCP path when MCP responds", async () => {
    // Threading both resourceType AND a working MCP tool: the MCP
    // path should win — the decomposer fallback only fires when MCP
    // is silent. We pin this by reusing the captured S3 fixture that
    // already returns a parseable dollar amount via MCP.
    const tools = [
      createBillingMockTool(McpMocks.billing.s3BucketCost.success),
    ];
    const result = await getCostSavingsEstimate(
      s3Resource.arn,
      "AWS::S3::Bucket",
      tools,
    );
    expect(result).toBe("$0.02/month saved");
  });
});

const snsResource: ManagedResource = {
  resourceType: "AWS::SNS::Topic",
  arn: "arn:aws:sns:us-east-1:210987654321:alerts",
  region: "us-east-1",
  createdDate: "2026-04-15",
  estimatedMonthlyCost: "N/A",
};

const ddbResource: ManagedResource = {
  resourceType: "AWS::DynamoDB::Table",
  arn: "arn:aws:dynamodb:us-east-1:210987654321:table/events",
  region: "us-east-1",
  createdDate: "2026-04-15",
  estimatedMonthlyCost: "N/A",
};

describe("fetchBillingData SNS/DDB MCP-response pinning (A-10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProvisions.mockResolvedValue([]);
  });

  it("pins SNS actualMonthlyCost to $-formatted raw MCP Unblended amount", async () => {
    const snsMcpResponse = {
      status: "success",
      data: {
        status: "success",
        data_stored: true,
        table_name: "getCostAndUsage_mock",
        schema: ["key", "value"],
        preview: [
          {
            key: "ResultsByTime",
            value: JSON.stringify([
              {
                TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
                Groups: [
                  {
                    Keys: ["Amazon Simple Notification Service"],
                    Metrics: {
                      UnblendedCost: { Amount: "0.50", Unit: "USD" },
                    },
                  },
                ],
                Total: {},
                Estimated: true,
              },
            ]),
          },
        ],
      },
    };
    const tools = [createBillingMockTool(snsMcpResponse)];
    const result = await fetchBillingData([snsResource], tools);
    const entry = result.get(snsResource.arn)!;
    expect(entry.actualMonthlyCost).toBe("$0.50/month");
    expect(entry.currency).toBe("USD");
    expect(entry.source).toBe("mcp");
  });

  it("pins DDB actualMonthlyCost to $-formatted raw MCP Unblended amount", async () => {
    const ddbMcpResponse = {
      status: "success",
      data: {
        status: "success",
        data_stored: true,
        table_name: "getCostAndUsage_mock",
        schema: ["key", "value"],
        preview: [
          {
            key: "ResultsByTime",
            value: JSON.stringify([
              {
                TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
                Groups: [
                  {
                    Keys: ["Amazon DynamoDB"],
                    Metrics: {
                      UnblendedCost: { Amount: "1.25", Unit: "USD" },
                    },
                  },
                ],
                Total: {},
                Estimated: true,
              },
            ]),
          },
        ],
      },
    };
    const tools = [createBillingMockTool(ddbMcpResponse)];
    const result = await fetchBillingData([ddbResource], tools);
    const entry = result.get(ddbResource.arn)!;
    expect(entry.actualMonthlyCost).toBe("$1.25/month");
    expect(entry.currency).toBe("USD");
    expect(entry.source).toBe("mcp");
  });
});
