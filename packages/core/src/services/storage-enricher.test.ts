/**
 * Tests for createCloudWatchUsageEnricher (S3 + CloudFront).
 *
 * Mocks: @aws-sdk/client-cloudwatch (CloudWatchClient.send +
 * GetMetricStatisticsCommand). Real: ARN parsing, region grouping,
 * datapoint selection, bytes→GB conversion, concurrency.
 *
 * Closes F6 (S3 path) and the CloudFront half (2026-05-25 follow-up).
 *
 * @see _backlog/wizard-ux-audit-2026-05-22.md F6
 * @see packages/core/src/list-resources/pricing-enricher.ts (consumer)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ManagedResource } from "../list-resources/types.js";

// vi.mock hoists ABOVE module-scope const declarations — using
// `vi.hoisted` puts the shared mock state in the same hoisted phase
// so the mock factory can reference it by closure.
const { mockSend, mockDestroy, cloudWatchClientCalls } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockDestroy: vi.fn(),
  cloudWatchClientCalls: [] as Array<{ region?: string }>,
}));

// Class-style mock mirrors the existing repo pattern (see
// apps/cli/src/commands/destroy/bulk-action.test.ts). `vi.fn() +
// mockImplementation` with `new` is brittle across vitest versions
// (the `new`-vs-call distinction doesn't always preserve the
// implementation's return value); a real class is unambiguous.
vi.mock("@aws-sdk/client-cloudwatch", () => {
  class CloudWatchClient {
    constructor(opts: { region?: string }) {
      cloudWatchClientCalls.push(opts);
    }
    send = mockSend;
    destroy = mockDestroy;
  }
  function GetMetricStatisticsCommand(input: unknown) {
    return { input };
  }
  return { CloudWatchClient, GetMetricStatisticsCommand };
});

// Import AFTER the mock so the enricher picks up the mocked SDK.
const { createCloudWatchUsageEnricher } = await import("./storage-enricher.js");

const CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

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

/** Build a CloudWatch GetMetricStatistics response with one Average datapoint (S3). */
function statsResponse(bytes: number, timestamp: Date = new Date()) {
  return {
    Datapoints: [
      {
        Timestamp: timestamp,
        Average: bytes,
        Unit: "Bytes",
      },
    ],
    Label: "BucketSizeBytes",
  };
}

/**
 * Build a CloudWatch GetMetricStatistics response with N daily Sum
 * datapoints — matches the CloudFront `Requests`/`BytesDownloaded`
 * shape (Sum statistic, daily Period).
 */
function sumResponse(perDay: number[], unit = "Count") {
  const now = Date.now();
  return {
    Datapoints: perDay.map((sum, i) => ({
      Timestamp: new Date(now - i * 86_400_000),
      Sum: sum,
      Unit: unit,
    })),
    Label: "metric",
  };
}

describe("createCloudWatchUsageEnricher — S3 BucketSizeBytes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloudWatchClientCalls.length = 0;
  });

  it("returns empty map when no S3 buckets or CloudFront distributions in input", async () => {
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([
      makeResource(
        "arn:aws:kms:us-east-1:112233445566:key/abc",
        "AWS::KMS::Key",
      ),
      makeResource(
        "arn:aws:iam::112233445566:role/test-role",
        "AWS::IAM::Role",
        "global",
      ),
    ]);
    expect(result.size).toBe(0);
    // No SDK call happens when there are no in-scope resources.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("converts BucketSizeBytes datapoint to GB and emits one map entry", async () => {
    // 50 GB worth of bytes (AWS billing convention: 10^9 bytes / GB)
    const fiftyGBInBytes = 50_000_000_000;
    mockSend.mockResolvedValue(statsResponse(fiftyGBInBytes));

    const arn = "arn:aws:s3:::test-bucket-50gb";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    expect(result.get(arn)).toEqual({ storageGB: 50 });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("forwards the bucket name as BucketName dimension on the GetMetricStatistics call", async () => {
    mockSend.mockResolvedValue(statsResponse(1_000_000_000));

    const arn = "arn:aws:s3:::test-bucket-with-extracted-name";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    const command = mockSend.mock.calls[0]![0]!;
    expect(command.input.Namespace).toBe("AWS/S3");
    expect(command.input.MetricName).toBe("BucketSizeBytes");
    expect(command.input.Dimensions).toEqual([
      { Name: "BucketName", Value: "test-bucket-with-extracted-name" },
      { Name: "StorageType", Value: "StandardStorage" },
    ]);
    expect(command.input.Period).toBe(86_400);
    expect(command.input.Statistics).toEqual(["Average"]);
  });

  it("uses the latest datapoint when CloudWatch returns multiple", async () => {
    // Two daily datapoints — yesterday and today. Enricher MUST pick today.
    const today = new Date("2026-05-24T00:00:00Z");
    const yesterday = new Date("2026-05-23T00:00:00Z");
    mockSend.mockResolvedValue({
      Datapoints: [
        { Timestamp: yesterday, Average: 1_000_000_000 }, // 1 GB
        { Timestamp: today, Average: 5_000_000_000 }, // 5 GB
      ],
    });

    const arn = "arn:aws:s3:::test-bucket-multi-datapoint";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    expect(result.get(arn)).toEqual({ storageGB: 5 });
  });

  it("omits ARN when CloudWatch returns zero datapoints (freshly-created bucket)", async () => {
    mockSend.mockResolvedValue({ Datapoints: [] });

    const arn = "arn:aws:s3:::test-bucket-no-datapoints";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    // No data → no entry → consumer falls back to rate-hint display.
    expect(result.has(arn)).toBe(false);
  });

  it("omits ARN when CloudWatch throws (IAM denial, bucket deleted, etc.)", async () => {
    mockSend.mockRejectedValue(
      new Error("AccessDenied: User has no cloudwatch:GetMetricStatistics"),
    );

    const arn = "arn:aws:s3:::test-bucket-iam-denied";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    expect(result.has(arn)).toBe(false);
  });

  it("filters out non-S3 / non-CloudFront resources before calling CloudWatch", async () => {
    mockSend.mockResolvedValue(statsResponse(2_000_000_000));

    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([
      makeResource(
        "arn:aws:kms:us-east-1:112233445566:key/abc",
        "AWS::KMS::Key",
      ),
      makeResource("arn:aws:s3:::only-s3-bucket", "AWS::S3::Bucket"),
      makeResource(
        "arn:aws:lambda:us-east-1:112233445566:function:fn",
        "AWS::Lambda::Function",
      ),
    ]);

    expect(result.size).toBe(1);
    expect(result.get("arn:aws:s3:::only-s3-bucket")).toEqual({
      storageGB: 2,
    });
    // Exactly one SDK call: for the S3 bucket only.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("groups buckets by their own region (not the listing region)", async () => {
    // Two buckets in different regions. Each region should get its own
    // CloudWatch client; both buckets should be queried.
    mockSend.mockResolvedValue(statsResponse(1_000_000_000));

    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    await enricher([
      makeResource("arn:aws:s3:::us-bucket", "AWS::S3::Bucket", "us-east-1"),
      makeResource("arn:aws:s3:::eu-bucket", "AWS::S3::Bucket", "eu-west-1"),
    ]);

    // One CloudWatchClient per region (constructor invocation recorded
    // via the mock class's constructor).
    const regions = cloudWatchClientCalls.map((c) => c.region).sort();
    expect(regions).toEqual(["eu-west-1", "us-east-1"]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("treats region='global' resources as living in the listing region", async () => {
    // S3 buckets are normally region-scoped — but defensive: a global
    // resource should still get bucketed under the listing region so
    // the CloudWatch client is initialised somewhere reasonable.
    mockSend.mockResolvedValue(statsResponse(3_000_000_000));

    const enricher = createCloudWatchUsageEnricher(CREDS, "ap-south-1");
    await enricher([
      makeResource("arn:aws:s3:::global-bucket", "AWS::S3::Bucket", "global"),
    ]);

    const regions = cloudWatchClientCalls.map((c) => c.region);
    expect(regions).toContain("ap-south-1");
  });

  it("skips ARNs that don't match the S3 bucket shape (defensive)", async () => {
    mockSend.mockResolvedValue(statsResponse(1_000_000_000));

    // ARN claims S3 type but the format is wrong (object ARN, not bucket).
    // Defensive: the enricher should skip without crashing.
    const malformed = "arn:aws:s3:::"; // empty name
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(malformed, "AWS::S3::Bucket")]);

    expect(result.size).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never throws — survives an exploding individual task without poisoning the pool", async () => {
    // First bucket throws; second succeeds. The second result must
    // still land in the map.
    mockSend
      .mockRejectedValueOnce(new Error("first bucket explodes"))
      .mockResolvedValueOnce(statsResponse(7_000_000_000));

    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([
      makeResource("arn:aws:s3:::bucket-explodes", "AWS::S3::Bucket"),
      makeResource("arn:aws:s3:::bucket-survives", "AWS::S3::Bucket"),
    ]);

    expect(result.has("arn:aws:s3:::bucket-explodes")).toBe(false);
    expect(result.get("arn:aws:s3:::bucket-survives")).toEqual({
      storageGB: 7,
    });
  });

  it("respects concurrency limit (no more than N parallel in-flight calls)", async () => {
    // Throw a sentinel so we can count concurrent calls. Each task
    // records "in-flight" on entry and "settled" on exit; max
    // simultaneous in-flight count must equal the configured limit.
    let inFlight = 0;
    let maxObserved = 0;
    mockSend.mockImplementation(async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return statsResponse(1_000_000_000);
    });

    // 20 buckets, concurrency=3 → max in-flight should never exceed 3.
    const buckets = Array.from({ length: 20 }, (_, i) =>
      makeResource(`arn:aws:s3:::bucket-${i}`, "AWS::S3::Bucket"),
    );
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1", 3);
    await enricher(buckets);

    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(mockSend).toHaveBeenCalledTimes(20);
  });

  it("calls destroy() on every spawned CloudWatch client (no socket leaks)", async () => {
    mockSend.mockResolvedValue(statsResponse(1_000_000_000));

    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    await enricher([
      makeResource("arn:aws:s3:::a", "AWS::S3::Bucket", "us-east-1"),
      makeResource("arn:aws:s3:::b", "AWS::S3::Bucket", "eu-west-1"),
      makeResource("arn:aws:s3:::c", "AWS::S3::Bucket", "ap-south-1"),
    ]);

    // 3 region-distinct clients spawned; each one destroyed once.
    expect(mockDestroy).toHaveBeenCalledTimes(3);
  });

  it("uses AWS billing convention 10^9 bytes/GB (NOT 2^30)", async () => {
    // 1 GB in AWS billing = 1_000_000_000 bytes, NOT 1_073_741_824.
    // The rate card is in GB-month at the billing definition, so the
    // multiplication must use the same definition.
    mockSend.mockResolvedValue(statsResponse(1_000_000_000));

    const arn = "arn:aws:s3:::test-exactly-1gb";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    expect(result.get(arn)).toEqual({ storageGB: 1 });
  });
});

// ──────────────────────────────────────────────────────────────────
// F6 follow-up (2026-05-25) — CloudFront baseline cost.
// Enricher additionally pulls `Requests` + `BytesDownloaded` from
// the `AWS/CloudFront` namespace so the pricing-enricher can multiply
// the tiered data-transfer + per-request rates by actual traffic.
// ──────────────────────────────────────────────────────────────────

describe("createCloudWatchUsageEnricher — CloudFront Requests + BytesDownloaded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloudWatchClientCalls.length = 0;
  });

  /** Build a request-routing helper: returns Requests-shape vs
   *  BytesDownloaded-shape based on the command's MetricName. */
  function routeByMetric(opts: {
    requestsPerDay: number;
    bytesPerDay: number;
    days: number;
  }) {
    return (command: { input: { MetricName?: string } }) => {
      const name = command.input.MetricName;
      if (name === "Requests") {
        const perDay = Array.from(
          { length: opts.days },
          () => opts.requestsPerDay,
        );
        return Promise.resolve(sumResponse(perDay, "Count"));
      }
      if (name === "BytesDownloaded") {
        const perDay = Array.from(
          { length: opts.days },
          () => opts.bytesPerDay,
        );
        return Promise.resolve(sumResponse(perDay, "Bytes"));
      }
      return Promise.resolve({ Datapoints: [] });
    };
  }

  it("populates Requests + Bytes (in GB) for a distribution with daily traffic", async () => {
    // 1,000 requests/day × 30 days = 30,000 requests/month.
    // 1 GB/day × 30 days = 30 GB/month (1 GB = 10^9 bytes).
    mockSend.mockImplementation(
      routeByMetric({
        requestsPerDay: 1_000,
        bytesPerDay: 1_000_000_000,
        days: 30,
      }),
    );

    const arn = "arn:aws:cloudfront::112233445566:distribution/EXAMPLE12345";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    expect(result.get(arn)).toEqual({
      cloudfrontRequestsPerMonth: 30_000,
      cloudfrontBytesPerMonth: 30,
    });
    // Exactly two CloudWatch calls: Requests + BytesDownloaded.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("issues GetMetricStatistics on AWS/CloudFront with DistributionId + Region=Global dims, Sum stat", async () => {
    mockSend.mockImplementation(
      routeByMetric({ requestsPerDay: 100, bytesPerDay: 1e9, days: 1 }),
    );

    const arn = "arn:aws:cloudfront::112233445566:distribution/E1ABCDEFGHIJK";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    const requestsCall = mockSend.mock.calls.find(
      (c) => c[0]!.input.MetricName === "Requests",
    )?.[0];
    const bytesCall = mockSend.mock.calls.find(
      (c) => c[0]!.input.MetricName === "BytesDownloaded",
    )?.[0];

    expect(requestsCall).toBeDefined();
    expect(bytesCall).toBeDefined();
    for (const call of [requestsCall, bytesCall]) {
      expect(call!.input.Namespace).toBe("AWS/CloudFront");
      expect(call!.input.Statistics).toEqual(["Sum"]);
      expect(call!.input.Period).toBe(86_400);
      expect(call!.input.Dimensions).toEqual([
        { Name: "DistributionId", Value: "E1ABCDEFGHIJK" },
        { Name: "Region", Value: "Global" },
      ]);
    }
  });

  it("uses us-east-1 for the CloudWatch client even when distribution.region is 'global'", async () => {
    // CloudFront metrics are global → published to us-east-1. The
    // enricher MUST hard-pin the CloudWatch client region regardless
    // of the RGTA stamp.
    mockSend.mockImplementation(
      routeByMetric({ requestsPerDay: 0, bytesPerDay: 0, days: 1 }),
    );

    const arn = "arn:aws:cloudfront::112233445566:distribution/EREGIONPIN";
    const enricher = createCloudWatchUsageEnricher(CREDS, "eu-west-1");
    await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    const regions = cloudWatchClientCalls.map((c) => c.region);
    expect(regions).toContain("us-east-1");
  });

  it("returns 0/0 (not undefined) when CloudWatch reports no traffic (idle distribution)", async () => {
    // Empty datapoints → sum = 0 → populated as 0 → pricing-enricher
    // treats this as "no usable multiplier" and falls back to the
    // rate-hint display (per ResourceUsage field contract).
    mockSend.mockResolvedValue({ Datapoints: [] });

    const arn = "arn:aws:cloudfront::112233445566:distribution/EIDLE12345";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    expect(result.get(arn)).toEqual({
      cloudfrontRequestsPerMonth: 0,
      cloudfrontBytesPerMonth: 0,
    });
  });

  it("omits the ARN entirely when one of the two metric calls throws (IAM denied, throttle)", async () => {
    // First call (Requests) succeeds, second call (BytesDownloaded)
    // throws — entire distribution is dropped from the map (consumer
    // falls back to the rate-hint branch gracefully).
    mockSend.mockImplementation(
      (command: { input: { MetricName?: string } }) => {
        if (command.input.MetricName === "Requests") {
          return Promise.resolve(sumResponse([1_000], "Count"));
        }
        return Promise.reject(
          new Error(
            "AccessDenied: cloudwatch:GetMetricStatistics on AWS/CloudFront",
          ),
        );
      },
    );

    const arn = "arn:aws:cloudfront::112233445566:distribution/EIAMDENIED";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([
      makeResource(arn, "AWS::CloudFront::Distribution", "global"),
    ]);

    expect(result.has(arn)).toBe(false);
  });

  it("processes multiple distributions in parallel and populates each independently", async () => {
    // Distribution-aware routing: traffic varies per distribution ID
    // so each map entry must reflect the right value.
    mockSend.mockImplementation(
      (command: {
        input: {
          MetricName?: string;
          Dimensions?: Array<{ Name?: string; Value?: string }>;
        };
      }) => {
        const idDim = command.input.Dimensions?.find(
          (d) => d.Name === "DistributionId",
        );
        const id = idDim?.Value ?? "";
        // Distribution-specific traffic.
        const trafficById: Record<
          string,
          { reqsPerDay: number; bytesPerDay: number }
        > = {
          EONE: { reqsPerDay: 100, bytesPerDay: 1e9 },
          ETWO: { reqsPerDay: 500, bytesPerDay: 5e9 },
          ETHREE: { reqsPerDay: 1_000, bytesPerDay: 1e10 },
        };
        const t = trafficById[id] ?? { reqsPerDay: 0, bytesPerDay: 0 };
        const perDay = Array.from({ length: 30 }, () =>
          command.input.MetricName === "Requests"
            ? t.reqsPerDay
            : t.bytesPerDay,
        );
        return Promise.resolve(
          sumResponse(
            perDay,
            command.input.MetricName === "Requests" ? "Count" : "Bytes",
          ),
        );
      },
    );

    const arns = [
      "arn:aws:cloudfront::112233445566:distribution/EONE",
      "arn:aws:cloudfront::112233445566:distribution/ETWO",
      "arn:aws:cloudfront::112233445566:distribution/ETHREE",
    ];
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher(
      arns.map((a) =>
        makeResource(a, "AWS::CloudFront::Distribution", "global"),
      ),
    );

    // Each distribution gets its own count/bytes (verifies parallel
    // calls correctly route by DistributionId).
    expect(result.get(arns[0]!)).toEqual({
      cloudfrontRequestsPerMonth: 100 * 30,
      cloudfrontBytesPerMonth: 30, // 1e9 × 30 / 1e9 = 30 GB
    });
    expect(result.get(arns[1]!)).toEqual({
      cloudfrontRequestsPerMonth: 500 * 30,
      cloudfrontBytesPerMonth: 150, // 5e9 × 30 / 1e9 = 150 GB
    });
    expect(result.get(arns[2]!)).toEqual({
      cloudfrontRequestsPerMonth: 1_000 * 30,
      cloudfrontBytesPerMonth: 300, // 1e10 × 30 / 1e9 = 300 GB
    });
    // 3 distributions × 2 metrics = 6 CloudWatch calls.
    expect(mockSend).toHaveBeenCalledTimes(6);
  });

  it("skips distributions whose ARN doesn't match the CloudFront shape (defensive)", async () => {
    mockSend.mockImplementation(
      routeByMetric({ requestsPerDay: 100, bytesPerDay: 1e9, days: 30 }),
    );

    const malformed = "arn:aws:cloudfront:::"; // empty distribution slot
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([
      makeResource(malformed, "AWS::CloudFront::Distribution", "global"),
    ]);

    expect(result.has(malformed)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("mixes S3 + CloudFront cleanly — both populate their own fields", async () => {
    // Routing logic distinguishes by Namespace + MetricName.
    mockSend.mockImplementation(
      (command: { input: { Namespace?: string; MetricName?: string } }) => {
        if (command.input.Namespace === "AWS/S3") {
          return Promise.resolve(statsResponse(2_000_000_000)); // 2 GB
        }
        if (command.input.MetricName === "Requests") {
          return Promise.resolve(sumResponse([500, 500], "Count")); // 1000 reqs
        }
        if (command.input.MetricName === "BytesDownloaded") {
          return Promise.resolve(sumResponse([5e8, 5e8], "Bytes")); // 1 GB
        }
        return Promise.resolve({ Datapoints: [] });
      },
    );

    const s3Arn = "arn:aws:s3:::mixed-bucket";
    const cfArn = "arn:aws:cloudfront::112233445566:distribution/EMIXED";
    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1");
    const result = await enricher([
      makeResource(s3Arn, "AWS::S3::Bucket"),
      makeResource(cfArn, "AWS::CloudFront::Distribution", "global"),
    ]);

    expect(result.get(s3Arn)).toEqual({ storageGB: 2 });
    expect(result.get(cfArn)).toEqual({
      cloudfrontRequestsPerMonth: 1_000,
      cloudfrontBytesPerMonth: 1, // 1e9 bytes = 1 GB
    });
  });

  it("respects bounded concurrency for mixed S3 + CloudFront workloads", async () => {
    // 3 buckets + 2 distributions = 5 tasks (CF fans two reads in
    // parallel inside one task, so the queue counts 5 outer tasks).
    let inFlight = 0;
    let maxObserved = 0;
    mockSend.mockImplementation(async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return statsResponse(1_000_000_000);
    });

    const enricher = createCloudWatchUsageEnricher(CREDS, "us-east-1", 2);
    const inputs: ManagedResource[] = [
      makeResource("arn:aws:s3:::b1", "AWS::S3::Bucket"),
      makeResource("arn:aws:s3:::b2", "AWS::S3::Bucket"),
      makeResource("arn:aws:s3:::b3", "AWS::S3::Bucket"),
      makeResource(
        "arn:aws:cloudfront::112233445566:distribution/E1",
        "AWS::CloudFront::Distribution",
        "global",
      ),
      makeResource(
        "arn:aws:cloudfront::112233445566:distribution/E2",
        "AWS::CloudFront::Distribution",
        "global",
      ),
    ];
    await enricher(inputs);

    // CloudFront task itself fans two parallel reads internally, so
    // observed in-flight may exceed `concurrency` by the CF fan-out
    // factor. The hard ceiling we assert is `concurrency × CF_FANOUT`
    // where CF_FANOUT is 2 (Requests + BytesDownloaded). Outer-task
    // concurrency is still bounded.
    expect(maxObserved).toBeLessThanOrEqual(2 * 2);
  });
});
