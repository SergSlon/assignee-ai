/**
 * Tests for createCloudWatchStorageEnricher.
 *
 * Mocks: @aws-sdk/client-cloudwatch (CloudWatchClient.send +
 * GetMetricStatisticsCommand). Real: ARN parsing, region grouping,
 * datapoint selection, bytes→GB conversion, concurrency.
 *
 * Closes the F6 audit follow-up (StorageEnricher implementation).
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
const { createCloudWatchStorageEnricher } =
  await import("./storage-enricher.js");

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

/** Build a CloudWatch GetMetricStatistics response with one datapoint. */
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

describe("createCloudWatchStorageEnricher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloudWatchClientCalls.length = 0;
  });

  it("returns empty map when no S3 buckets in input", async () => {
    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
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
    // No SDK call happens when there are no S3 buckets.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("converts BucketSizeBytes datapoint to GB and emits one map entry", async () => {
    // 50 GB worth of bytes (AWS billing convention: 10^9 bytes / GB)
    const fiftyGBInBytes = 50_000_000_000;
    mockSend.mockResolvedValue(statsResponse(fiftyGBInBytes));

    const arn = "arn:aws:s3:::test-bucket-50gb";
    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    expect(result.get(arn)).toEqual({ storageGB: 50 });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("forwards the bucket name as BucketName dimension on the GetMetricStatistics call", async () => {
    mockSend.mockResolvedValue(statsResponse(1_000_000_000));

    const arn = "arn:aws:s3:::test-bucket-with-extracted-name";
    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
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
    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    expect(result.get(arn)).toEqual({ storageGB: 5 });
  });

  it("omits ARN when CloudWatch returns zero datapoints (freshly-created bucket)", async () => {
    mockSend.mockResolvedValue({ Datapoints: [] });

    const arn = "arn:aws:s3:::test-bucket-no-datapoints";
    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    // No data → no entry → consumer falls back to rate-hint display.
    expect(result.has(arn)).toBe(false);
  });

  it("omits ARN when CloudWatch throws (IAM denial, bucket deleted, etc.)", async () => {
    mockSend.mockRejectedValue(
      new Error("AccessDenied: User has no cloudwatch:GetMetricStatistics"),
    );

    const arn = "arn:aws:s3:::test-bucket-iam-denied";
    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    expect(result.has(arn)).toBe(false);
  });

  it("filters out non-S3 resources before calling CloudWatch", async () => {
    mockSend.mockResolvedValue(statsResponse(2_000_000_000));

    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
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

    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
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

    const enricher = createCloudWatchStorageEnricher(CREDS, "ap-south-1");
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
    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
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

    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
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
    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1", 3);
    await enricher(buckets);

    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(mockSend).toHaveBeenCalledTimes(20);
  });

  it("calls destroy() on every spawned CloudWatch client (no socket leaks)", async () => {
    mockSend.mockResolvedValue(statsResponse(1_000_000_000));

    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
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
    const enricher = createCloudWatchStorageEnricher(CREDS, "us-east-1");
    const result = await enricher([makeResource(arn, "AWS::S3::Bucket")]);

    expect(result.get(arn)).toEqual({ storageGB: 1 });
  });
});
