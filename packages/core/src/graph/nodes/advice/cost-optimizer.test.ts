/**
 * Unit tests for the A7 cost-optimizer node.
 *
 * The analyzer is pure except for its Pricing MCP dependency, which
 * is mocked at the module boundary via `vi.mock("../../utils/pricing-lookup")`.
 * Every test exercises real recommendation math against real-shaped
 * `$X.XXXX/hr` strings — no rounded placeholders.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOURCE_TYPES, CfnKey } from "../../../index.js";

const {
  mockFetchEc2Prices,
  mockFetchRdsPrices,
  mockFetchLambdaArchPrices,
  mockFetchCwLogsStoragePrice,
} = vi.hoisted(() => ({
  mockFetchEc2Prices: vi.fn(),
  mockFetchRdsPrices: vi.fn(),
  mockFetchLambdaArchPrices: vi.fn(),
  mockFetchCwLogsStoragePrice: vi.fn(),
}));

vi.mock("../../../utils/pricing-lookup.js", () => ({
  fetchEc2InstancePrices: mockFetchEc2Prices,
  fetchRdsInstancePrices: mockFetchRdsPrices,
  fetchLambdaArchPrices: mockFetchLambdaArchPrices,
  fetchCwLogsStoragePrice: mockFetchCwLogsStoragePrice,
}));

// Import after the mock is installed so the analyzer binds to the
// mocked pricing module.
import { analyzeEc2Instance } from "./cost-optimizer/ec2-analyzer.js";
import { analyzeRdsInstance } from "./cost-optimizer/rds-analyzer.js";
import { analyzeLambdaFunction } from "./cost-optimizer/lambda-analyzer.js";
import { analyzeLogsLogGroup } from "./cost-optimizer/logs-analyzer.js";
import { analyzeResource } from "./cost-optimizer/orchestrator.js";
import { buildRecommendation } from "./cost-optimizer/types.js";

const FAKE_EC2_ARN =
  "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0";
const FAKE_RDS_ARN = "arn:aws:rds:us-east-1:123456789012:db:prod-primary";
const FAKE_TOOLS = [] as never; // pricing-lookup is mocked so tools are never touched

beforeEach(() => {
  mockFetchEc2Prices.mockReset();
  mockFetchRdsPrices.mockReset();
  mockFetchLambdaArchPrices.mockReset();
  mockFetchCwLogsStoragePrice.mockReset();
});

const FAKE_LAMBDA_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:prod-handler";

describe("buildRecommendation (pure math)", () => {
  it("computes the correct monthly savings for a t3.large → t4g.large swap", () => {
    const rec = buildRecommendation({
      resourceArn: FAKE_EC2_ARN,
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      currentConfig: "t3.large",
      recommendedConfig: "t4g.large",
      // Real on-demand us-east-1 prices (captured from the pricing
      // MCP server on 2026-04-08). t3.large = $0.0832/hr,
      // t4g.large = $0.0672/hr.
      currentHourlyRaw: "$0.0832/hr",
      recommendedHourlyRaw: "$0.0672/hr",
      rationale: "test",
      confidence: "high",
    });

    expect(rec).not.toBeNull();
    // (0.0832 - 0.0672) * 730 = 0.016 * 730 = 11.68
    expect(rec!.savingsAbsoluteUsd).toBeCloseTo(11.68, 2);
    expect(rec!.monthlySavings).toBe("$11.68/mo");
    // 11.68 / 60.736 ≈ 19.23 → rounds to 19
    expect(rec!.savingsPercent).toBe(19);
    expect(rec!.confidence).toBe("high");
  });

  it("returns null when the recommended price is not strictly cheaper", () => {
    const rec = buildRecommendation({
      resourceArn: FAKE_EC2_ARN,
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      currentConfig: "t3.large",
      recommendedConfig: "t4g.large",
      currentHourlyRaw: "$0.05/hr",
      recommendedHourlyRaw: "$0.05/hr", // same
      rationale: "test",
      confidence: "high",
    });
    expect(rec).toBeNull();
  });

  it("returns null when the recommended price is more expensive", () => {
    const rec = buildRecommendation({
      resourceArn: FAKE_EC2_ARN,
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      currentConfig: "t3.large",
      recommendedConfig: "t4g.large",
      currentHourlyRaw: "$0.05/hr",
      recommendedHourlyRaw: "$0.06/hr",
      rationale: "test",
      confidence: "high",
    });
    expect(rec).toBeNull();
  });

  it("returns null when either price is missing from the MCP response", () => {
    expect(
      buildRecommendation({
        resourceArn: FAKE_EC2_ARN,
        resourceType: RESOURCE_TYPES.EC2_INSTANCE,
        currentConfig: "t3.large",
        recommendedConfig: "t4g.large",
        currentHourlyRaw: "",
        recommendedHourlyRaw: "$0.05/hr",
        rationale: "test",
        confidence: "high",
      }),
    ).toBeNull();
    expect(
      buildRecommendation({
        resourceArn: FAKE_EC2_ARN,
        resourceType: RESOURCE_TYPES.EC2_INSTANCE,
        currentConfig: "t3.large",
        recommendedConfig: "t4g.large",
        currentHourlyRaw: "$0.05/hr",
        recommendedHourlyRaw: "not-a-price",
        rationale: "test",
        confidence: "high",
      }),
    ).toBeNull();
  });

  it("drops recommendations with sub-cent savings", () => {
    // 0.050001 vs 0.05 → delta ~0.000001/hr * 730 ≈ 0.00073 → below cent floor.
    const rec = buildRecommendation({
      resourceArn: FAKE_EC2_ARN,
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      currentConfig: "t3.large",
      recommendedConfig: "t4g.large",
      currentHourlyRaw: "$0.050001/hr",
      recommendedHourlyRaw: "$0.05/hr",
      rationale: "test",
      confidence: "high",
    });
    expect(rec).toBeNull();
  });
});

describe("analyzeEc2Instance", () => {
  it("suggests the ARM equivalent when one exists and the swap is cheaper", async () => {
    mockFetchEc2Prices.mockResolvedValueOnce({
      "t3.large": "$0.0832/hr",
      "t4g.large": "$0.0672/hr",
    });

    const rec = await analyzeEc2Instance(
      FAKE_EC2_ARN,
      { [CfnKey.INSTANCE_TYPE]: "t3.large" },
      FAKE_TOOLS,
    );

    expect(rec).not.toBeNull();
    expect(rec!.currentConfig).toBe("t3.large");
    expect(rec!.recommendedConfig).toBe("t4g.large");
    expect(rec!.confidence).toBe("high");
    // The analyzer must ask for BOTH instance types in one call so the
    // caller can compare prices from a single MCP round-trip.
    expect(mockFetchEc2Prices).toHaveBeenCalledWith(FAKE_TOOLS, [
      "t3.large",
      "t4g.large",
    ]);
  });

  it("returns null when the instance type is not in the ARM equivalence map", async () => {
    const rec = await analyzeEc2Instance(
      FAKE_EC2_ARN,
      { [CfnKey.INSTANCE_TYPE]: "a1.large" }, // no mapping for a1.*
      FAKE_TOOLS,
    );
    expect(rec).toBeNull();
    expect(mockFetchEc2Prices).not.toHaveBeenCalled();
  });

  it("returns null when desiredState has no InstanceType", async () => {
    const rec = await analyzeEc2Instance(FAKE_EC2_ARN, {}, FAKE_TOOLS);
    expect(rec).toBeNull();
    expect(mockFetchEc2Prices).not.toHaveBeenCalled();
  });

  it("gracefully degrades when the Pricing MCP returns no price for either type", async () => {
    mockFetchEc2Prices.mockResolvedValueOnce({});
    const rec = await analyzeEc2Instance(
      FAKE_EC2_ARN,
      { [CfnKey.INSTANCE_TYPE]: "t3.large" },
      FAKE_TOOLS,
    );
    expect(rec).toBeNull();
  });
});

describe("analyzeRdsInstance", () => {
  it("suggests the Graviton equivalent for db.r5.large → db.r6g.large", async () => {
    mockFetchRdsPrices.mockResolvedValueOnce({
      "db.r5.large": "$0.2400/hr",
      "db.r6g.large": "$0.2160/hr",
    });

    const rec = await analyzeRdsInstance(
      FAKE_RDS_ARN,
      {
        [CfnKey.DB_INSTANCE_CLASS]: "db.r5.large",
        [CfnKey.ENGINE]: "postgres",
      },
      FAKE_TOOLS,
    );

    expect(rec).not.toBeNull();
    expect(rec!.currentConfig).toBe("db.r5.large");
    expect(rec!.recommendedConfig).toBe("db.r6g.large");
    expect(rec!.confidence).toBe("medium");
    expect(mockFetchRdsPrices).toHaveBeenCalledWith(
      FAKE_TOOLS,
      ["db.r5.large", "db.r6g.large"],
      "postgres",
    );
  });

  it("returns null when the instance class has no Graviton mapping", async () => {
    const rec = await analyzeRdsInstance(
      FAKE_RDS_ARN,
      {
        [CfnKey.DB_INSTANCE_CLASS]: "db.x2gd.xlarge",
        [CfnKey.ENGINE]: "postgres",
      },
      FAKE_TOOLS,
    );
    expect(rec).toBeNull();
    expect(mockFetchRdsPrices).not.toHaveBeenCalled();
  });

  it("returns null when desiredState is missing the engine", async () => {
    const rec = await analyzeRdsInstance(
      FAKE_RDS_ARN,
      { [CfnKey.DB_INSTANCE_CLASS]: "db.r5.large" },
      FAKE_TOOLS,
    );
    expect(rec).toBeNull();
  });
});

describe("analyzeLambdaFunction", () => {
  it("recommends arm64 for a default (undefined Architectures) Lambda function", async () => {
    // AWS published rates for AWSLambda Duration SKUs (us-east-1,
    // 2026-04-08):
    //   Lambda-GB-Second     = $0.0000166667
    //   Lambda-GB-Second-ARM = $0.0000133334
    // parseHourly() strips the "/hr" stamp and keeps the raw
    // numeric rate so the percent math works regardless of units.
    mockFetchLambdaArchPrices.mockResolvedValueOnce({
      x86: "$0.0000166667/hr",
      arm: "$0.0000133334/hr",
    });

    const rec = await analyzeLambdaFunction(
      FAKE_LAMBDA_ARN,
      {}, // no Architectures → x86_64 default
      FAKE_TOOLS,
    );

    expect(rec).not.toBeNull();
    expect(rec!.currentConfig).toBe("x86_64");
    expect(rec!.recommendedConfig).toBe("arm64");
    expect(rec!.confidence).toBe("medium");
    // 20% is the canonical AWS-published delta; the real math must
    // land within ±1 percentage point.
    expect(rec!.savingsPercent).toBeGreaterThanOrEqual(19);
    expect(rec!.savingsPercent).toBeLessThanOrEqual(21);
    // Savings string carries the trailing asterisk marker that
    // documents the "reference workload" caveat.
    expect(rec!.monthlySavings.endsWith("/mo*")).toBe(true);
  });

  it('recommends arm64 when Architectures is explicitly ["x86_64"]', async () => {
    mockFetchLambdaArchPrices.mockResolvedValueOnce({
      x86: "$0.0000166667/hr",
      arm: "$0.0000133334/hr",
    });

    const rec = await analyzeLambdaFunction(
      FAKE_LAMBDA_ARN,
      { Architectures: ["x86_64"] },
      FAKE_TOOLS,
    );

    expect(rec).not.toBeNull();
    expect(rec!.currentConfig).toBe("x86_64");
  });

  it('returns null when Architectures is already ["arm64"]', async () => {
    const rec = await analyzeLambdaFunction(
      FAKE_LAMBDA_ARN,
      { Architectures: ["arm64"] },
      FAKE_TOOLS,
    );
    expect(rec).toBeNull();
    // The analyzer must short-circuit before hitting the Pricing MCP —
    // no point burning an MCP call for a no-op.
    expect(mockFetchLambdaArchPrices).not.toHaveBeenCalled();
  });

  it("returns null when the Pricing MCP returns no prices", async () => {
    mockFetchLambdaArchPrices.mockResolvedValueOnce({});
    const rec = await analyzeLambdaFunction(FAKE_LAMBDA_ARN, {}, FAKE_TOOLS);
    expect(rec).toBeNull();
  });

  it("returns null when the Pricing MCP returns only the x86 price", async () => {
    mockFetchLambdaArchPrices.mockResolvedValueOnce({
      x86: "$0.0000166667/hr",
    });
    const rec = await analyzeLambdaFunction(FAKE_LAMBDA_ARN, {}, FAKE_TOOLS);
    expect(rec).toBeNull();
  });
});

describe("analyzeResource dispatcher", () => {
  it("routes EC2::Instance to the EC2 analyzer", async () => {
    mockFetchEc2Prices.mockResolvedValueOnce({
      "m5.large": "$0.0960/hr",
      "m6g.large": "$0.0770/hr",
    });
    const rec = await analyzeResource(
      { arn: FAKE_EC2_ARN, resourceType: RESOURCE_TYPES.EC2_INSTANCE },
      { [CfnKey.INSTANCE_TYPE]: "m5.large" },
      FAKE_TOOLS,
    );
    expect(rec).not.toBeNull();
    expect(rec!.recommendedConfig).toBe("m6g.large");
  });

  it("routes RDS::DBInstance to the RDS analyzer", async () => {
    mockFetchRdsPrices.mockResolvedValueOnce({
      "db.m5.large": "$0.1700/hr",
      "db.m6g.large": "$0.1500/hr",
    });
    const rec = await analyzeResource(
      { arn: FAKE_RDS_ARN, resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE },
      {
        [CfnKey.DB_INSTANCE_CLASS]: "db.m5.large",
        [CfnKey.ENGINE]: "mysql",
      },
      FAKE_TOOLS,
    );
    expect(rec).not.toBeNull();
    expect(rec!.recommendedConfig).toBe("db.m6g.large");
  });

  it("routes Lambda::Function to the Lambda analyzer", async () => {
    mockFetchLambdaArchPrices.mockResolvedValueOnce({
      x86: "$0.0000166667/hr",
      arm: "$0.0000133334/hr",
    });
    const rec = await analyzeResource(
      { arn: FAKE_LAMBDA_ARN, resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION },
      {},
      FAKE_TOOLS,
    );
    expect(rec).not.toBeNull();
    expect(rec!.recommendedConfig).toBe("arm64");
  });

  it("returns null for resource types with no analyzer (graceful no-op)", async () => {
    const rec = await analyzeResource(
      {
        arn: "arn:aws:s3:::my-bucket",
        resourceType: RESOURCE_TYPES.S3_BUCKET,
      },
      {},
      FAKE_TOOLS,
    );
    expect(rec).toBeNull();
    // None of the type-specific analyzers were consulted.
    expect(mockFetchEc2Prices).not.toHaveBeenCalled();
    expect(mockFetchRdsPrices).not.toHaveBeenCalled();
    expect(mockFetchLambdaArchPrices).not.toHaveBeenCalled();
    expect(mockFetchCwLogsStoragePrice).not.toHaveBeenCalled();
  });

  it("routes Logs::LogGroup to the retention analyzer", async () => {
    mockFetchCwLogsStoragePrice.mockResolvedValueOnce("$0.03/hr");
    const rec = await analyzeResource(
      {
        arn: "arn:aws:logs:us-east-1:123:log-group:/aws/lambda/fn",
        resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
      },
      {},
      FAKE_TOOLS,
    );
    expect(rec).not.toBeNull();
    expect(rec!.recommendedConfig).toBe("RetentionInDays=30");
  });
});

// ── Task 8 (Epic 32 slice): CW Logs retention analyzer ───────────────────────

describe("analyzeLogsLogGroup", () => {
  const FAKE_LOG_ARN = "arn:aws:logs:us-east-1:123:log-group:/aws/lambda/app";

  it("returns a typed recommendation when RetentionInDays is missing", async () => {
    mockFetchCwLogsStoragePrice.mockResolvedValueOnce("$0.03/hr");
    const rec = await analyzeLogsLogGroup(FAKE_LOG_ARN, {}, FAKE_TOOLS);
    expect(rec).not.toBeNull();
    expect(rec!.resourceType).toBe(RESOURCE_TYPES.LOGS_LOG_GROUP);
    expect(rec!.currentConfig).toContain("never expire");
    expect(rec!.recommendedConfig).toBe("RetentionInDays=30");
    // 100 GB × $0.03/GB-month × 91% reduction = $2.73/mo
    expect(rec!.savingsAbsoluteUsd).toBeCloseTo(2.73, 2);
    expect(rec!.monthlySavings).toMatch(/^\$2\.73\/mo\*$/);
    expect(rec!.savingsPercent).toBe(91);
    expect(rec!.confidence).toBe("high");
    expect(rec!.rationale).toContain("never expire");
    expect(rec!.rationale).toContain("100 GB");
  });

  it("returns null when RetentionInDays is already set (any positive value)", async () => {
    for (const days of [1, 7, 30, 90, 365, 3650]) {
      const rec = await analyzeLogsLogGroup(
        FAKE_LOG_ARN,
        { [CfnKey.RETENTION_IN_DAYS]: days },
        FAKE_TOOLS,
      );
      expect(
        rec,
        `retention=${days} should be treated as already-configured`,
      ).toBeNull();
    }
    // Short-circuits before touching the pricing MCP.
    expect(mockFetchCwLogsStoragePrice).not.toHaveBeenCalled();
  });

  it("returns null when the pricing MCP is unavailable (graceful degradation)", async () => {
    mockFetchCwLogsStoragePrice.mockResolvedValueOnce(null);
    const rec = await analyzeLogsLogGroup(FAKE_LOG_ARN, {}, FAKE_TOOLS);
    expect(rec).toBeNull();
  });

  it("returns null when the MCP response cannot be parsed", async () => {
    mockFetchCwLogsStoragePrice.mockResolvedValueOnce("Pricing unavailable");
    const rec = await analyzeLogsLogGroup(FAKE_LOG_ARN, {}, FAKE_TOOLS);
    expect(rec).toBeNull();
  });

  it("treats RetentionInDays=0 as not-configured (edge case)", async () => {
    // CCAPI rejects 0 but callers might pass it; make sure the
    // analyzer doesn't treat it as a real retention setting.
    mockFetchCwLogsStoragePrice.mockResolvedValueOnce("$0.03/hr");
    const rec = await analyzeLogsLogGroup(
      FAKE_LOG_ARN,
      { [CfnKey.RETENTION_IN_DAYS]: 0 },
      FAKE_TOOLS,
    );
    expect(rec).not.toBeNull();
  });
});
