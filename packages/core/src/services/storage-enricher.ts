/**
 * CloudWatch-backed usage enricher for the `assignee admin list` and
 * `assignee infra destroy --all` cost displays.
 *
 * Originally introduced as the S3-only "storage enricher" for F6 of the
 * 2026-05-22 wizard UX audit. The 2026-05-25 follow-up (F6 CloudFront
 * closure) generalised the enricher to also pull `AWS/CloudFront`
 * `Requests` + `BytesDownloaded` metrics so the pricing-enricher can
 * multiply the per-request / per-GB rate ladder into real `$X.XX/mo`
 * totals for distributions too. The same-session follow-up F6-ITEM-3
 * (Quinn H1 closure) extended the S3 path to query EVERY storage class
 * (Standard, IA, OneZone-IA, Intelligent-Tiering, Glacier-IR, Glacier,
 * Deep Archive) in parallel so lifecycle-tiered buckets no longer
 * silently mis-cost. The public factory is now named
 * `createCloudWatchUsageEnricher`; the old `createCloudWatchStorageEnricher`
 * name has been retired (every call site is now using the new name).
 *
 * Per-resource failure → no entry in the returned map. The caller falls
 * back to the original rate-hint display (zero behavioural regression).
 * Never throws.
 *
 * Cost / latency: `GetMetricStatistics` is $0.01 / 1,000 calls + ~50ms
 * round-trip per call. Bounded concurrency (DEFAULT_CONCURRENCY=10)
 * keeps a 100-resource account at ~5s wall-clock + $0.001 — well below
 * the listing's existing Pricing-MCP latency budget. CloudFront
 * distributions issue TWO metric calls each (Requests + BytesDownloaded)
 * but those are queued in the same bounded queue so the concurrency cap
 * still holds. S3 buckets issue SEVEN parallel-inside-one-task metric
 * calls (one per storage class) — they share the same outer-task slot
 * in the bounded queue, but the per-bucket SDK pressure is ~7× the
 * single-class path. Throttling-headroom math: 10 outer × 7 inner = 70
 * peak in-flight calls, well under the 50-TPS CloudWatch quota with
 * 30-day-window queries that take ~100ms each (so peak in-flight TPS
 * sits at ~7, not 70).
 *
 * @see _backlog/wizard-ux-audit-2026-05-22.md F6
 * @see packages/core/src/list-resources/pricing-enricher.ts (consumer)
 */

import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type Datapoint,
} from "@aws-sdk/client-cloudwatch";
import type { ManagedResource } from "../list-resources/types.js";
import {
  S3_STORAGE_CLASSES,
  S3StorageClass,
  type ResourceUsage,
  type StorageEnricher,
} from "../list-resources/fetch-managed-resources.js";

/**
 * Default parallel CloudWatch calls — balances wall-clock vs throttling.
 *
 * CloudWatch's `GetMetricStatistics` quota is 50 TPS per account by
 * default (per the SDK docs, raisable via support ticket). 10 leaves
 * comfortable headroom for the operator's existing background queries
 * (alarms, dashboards, other tools' polling) without coordinating
 * burst-bucket usage. For a 100-resource account → ~10 batches × ~50ms
 * RTT = ~5s wall-clock + $0.001 CloudWatch cost.
 *
 * Bumping past 25 risks throttling (`Throttling` exception) on a busy
 * account; CloudWatch responds with no retry-after header so the
 * enricher would silently lose datapoints for the throttled resources.
 * Quinn L6 follow-up.
 */
const DEFAULT_CONCURRENCY = 10;

/** CFN resource type for S3 buckets. Match by exact string. */
const S3_BUCKET_TYPE = "AWS::S3::Bucket";

/** CFN resource type for CloudFront distributions. Match by exact string. */
const CLOUDFRONT_DISTRIBUTION_TYPE = "AWS::CloudFront::Distribution";

/**
 * S3 lookback window. `BucketSizeBytes` is published once per day around
 * midnight UTC; a 2-day window is the smallest one that reliably has
 * at least one datapoint even on a freshly-created bucket whose
 * first datapoint hasn't published yet (in which case we still return
 * no entry — the caller correctly falls back to rate-hint display).
 */
const S3_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/** S3 GetMetricStatistics period. `BucketSizeBytes` is daily so 86_400
 *  is the granularity AWS actually returns; smaller values produce
 *  zero data. */
const S3_PERIOD_SECONDS = 86_400;

/**
 * CloudFront lookback window — 30 days. CloudFront billing aggregates
 * monthly, so a 30-day rolling window is the cleanest approximation
 * of "what AWS would charge this distribution next month if traffic
 * stays at recent levels". Shorter windows over-amplify diurnal /
 * weekly patterns; longer windows lag behind real traffic shifts.
 */
const CLOUDFRONT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * CloudFront GetMetricStatistics period. Daily bucketing — CloudFront
 * publishes `Requests` and `BytesDownloaded` per-minute on the AWS
 * console, but Sum-on-daily-bucket aggregates the same totals while
 * keeping the response under the CloudWatch 1,440-datapoint cap (30
 * datapoints for a 30-day window).
 */
const CLOUDFRONT_PERIOD_SECONDS = 86_400;

/** AWS billing convention: 1 GB = 10^9 bytes (NOT 2^30). Matches what
 *  the Pricing API rates assume per-GB so the multiplication is
 *  self-consistent. */
const BYTES_PER_GB = 1_000_000_000;

/** Extract the bucket name from `arn:aws:s3:::<name>`. Returns null when
 *  the ARN doesn't match the S3 bucket shape (defensive — RGTA should
 *  always give us a valid bucket ARN for S3 resource types). */
function bucketNameFromArn(arn: string): string | null {
  const match = arn.match(/^arn:aws[\w-]*:s3:::(.+?)$/);
  return match ? match[1]! : null;
}

/**
 * Extract the distribution ID from a CloudFront distribution ARN.
 * Shape: `arn:aws:cloudfront::<account>:distribution/<DISTRIBUTION-ID>`.
 * Returns null when the ARN doesn't match (defensive — RGTA should
 * always give us a valid distribution ARN for CloudFront resource
 * types). Mirrors `bucketNameFromArn`'s partition-aware regex so
 * `aws-cn` / `aws-us-gov` ARNs are accepted.
 */
function distributionIdFromArn(arn: string): string | null {
  const match = arn.match(
    /^arn:aws[\w-]*:cloudfront::[^:]*:distribution\/(.+)$/,
  );
  return match ? match[1]! : null;
}

interface SdkCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Factory returning a `StorageEnricher` backed by CloudWatch
 * `GetMetricStatistics`. Closes over the credentials + region so the
 * caller (services/list-resources.ts) hands a clean
 * `(resources) => Promise<Map<...>>` to the pricing enricher.
 *
 * Handles two resource types today:
 *   - `AWS::S3::Bucket` — `BucketSizeBytes` fanned across all 7
 *     storage-class dimensions (Standard, Standard-IA, OneZone-IA,
 *     Intelligent-Tiering Frequent Access, Glacier Instant Retrieval,
 *     Glacier Flexible Retrieval, Deep Archive) via
 *     `Promise.allSettled`. Each class with at least one non-null
 *     `Average` datapoint contributes an entry to
 *     `ResourceUsage.storageByClass`. A class with no datapoints
 *     (the bucket has zero bytes there) is omitted entirely so the
 *     pricing-enricher can short-circuit the per-class MCP query for
 *     it. Per-class failures (e.g. transient throttle on the IA
 *     call but Standard succeeds) don't abort the bucket — the
 *     populated classes still land.
 *   - `AWS::CloudFront::Distribution` — `Requests` + `BytesDownloaded`
 *     (DistributionId dim, Region=Global) → `ResourceUsage.cloudfront*`.
 */
export function createCloudWatchUsageEnricher(
  credentials: SdkCredentials,
  region: string,
  concurrency: number = DEFAULT_CONCURRENCY,
): StorageEnricher {
  return async (resources: ManagedResource[]) => {
    const result = new Map<string, ResourceUsage>();
    const buckets = resources.filter(
      (r) => r.resourceType === S3_BUCKET_TYPE && r.arn,
    );
    const distributions = resources.filter(
      (r) => r.resourceType === CLOUDFRONT_DISTRIBUTION_TYPE && r.arn,
    );
    if (buckets.length === 0 && distributions.length === 0) return result;

    // Group buckets by their own region — buckets live in different
    // regions even within one account, and CloudWatch metrics are
    // region-scoped. A bucket in eu-west-1 won't surface its
    // BucketSizeBytes from us-east-1.
    const bucketsByRegion = new Map<string, ManagedResource[]>();
    for (const b of buckets) {
      const r = b.region === "global" ? region : b.region;
      const bucketsHere = bucketsByRegion.get(r) ?? [];
      bucketsHere.push(b);
      bucketsByRegion.set(r, bucketsHere);
    }

    // CloudFront metrics are ALWAYS published to us-east-1 regardless
    // of where the distribution's price-class edges serve traffic —
    // CloudFront is a global service in the IAM / RGTA sense. So we
    // hard-pin distribution metric reads to us-east-1 even when the
    // RGTA stamped `region="global"` on the row.
    const cloudfrontRegion = "us-east-1";

    // One CloudWatch client per region. Re-using is cheap; tearing down
    // matters less because the enricher exits when the listing finishes.
    const clients = new Map<string, CloudWatchClient>();
    for (const r of bucketsByRegion.keys()) {
      clients.set(r, new CloudWatchClient({ region: r, credentials }));
    }
    if (distributions.length > 0 && !clients.has(cloudfrontRegion)) {
      clients.set(
        cloudfrontRegion,
        new CloudWatchClient({ region: cloudfrontRegion, credentials }),
      );
    }

    // Bounded-concurrency queue. We avoid pulling in a dep like
    // p-limit / p-map to keep the surface tight — the queue here is a
    // few lines of plain async code.
    const tasks: Array<() => Promise<void>> = [];

    // ── S3 bucket tasks ────────────────────────────────────────────
    // F6-ITEM-3 (Quinn H1 closure) — each bucket fans out to 7 parallel
    // `BucketSizeBytes` calls (one per storage class) via
    // `Promise.allSettled` inside one outer-task slot. Empty datapoint
    // arrays for a class → omit that class entirely from
    // `storageByClass` (distinguishes "no observed data" from "0 GB
    // observed" so the consumer can skip the per-class MCP query). A
    // single-class throttle/IAM-denial doesn't abort the bucket — the
    // surviving class entries still land in the map. A bucket where
    // EVERY class returns no data → no `storageByClass` key set →
    // map.set() is skipped → pricing-enricher falls back to rate-hint
    // display (zero behavioural regression vs pre-F6).
    for (const [bucketRegion, group] of bucketsByRegion) {
      const client = clients.get(bucketRegion)!;
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - S3_LOOKBACK_MS);
      for (const bucket of group) {
        const arn = bucket.arn!;
        const name = bucketNameFromArn(arn);
        if (!name) continue;
        tasks.push(async () => {
          const settled = await Promise.allSettled(
            S3_STORAGE_CLASSES.map((cls) =>
              client.send(
                new GetMetricStatisticsCommand({
                  Namespace: "AWS/S3",
                  MetricName: "BucketSizeBytes",
                  Dimensions: [
                    { Name: "BucketName", Value: name },
                    { Name: "StorageType", Value: cls },
                  ],
                  StartTime: startTime,
                  EndTime: endTime,
                  Period: S3_PERIOD_SECONDS,
                  Statistics: ["Average"],
                }),
              ),
            ),
          );
          const storageByClass: Partial<Record<S3StorageClass, number>> = {};
          for (let i = 0; i < S3_STORAGE_CLASSES.length; i++) {
            const cls = S3_STORAGE_CLASSES[i]!;
            const outcome = settled[i]!;
            if (outcome.status !== "fulfilled") {
              // Per-class failure (IAM denial scoped to one dim,
              // transient throttle on one call): skip silently and
              // let the populated classes for this bucket still
              // land. Deliberately don't write to stderr per class
              // — would explode to 7N lines on missing-IAM accounts.
              continue;
            }
            const datapoints = (outcome.value as { Datapoints?: Datapoint[] })
              .Datapoints;
            const latest = pickLatestDatapoint(datapoints);
            if (latest?.Average !== undefined && latest.Average > 0) {
              storageByClass[cls] = latest.Average / BYTES_PER_GB;
            }
            // Omit zero / no-datapoint entries entirely — see the
            // F6-ITEM-3 field contract on `storageByClass`.
          }
          if (Object.keys(storageByClass).length > 0) {
            result.set(arn, { storageByClass });
          }
          // All 7 classes empty (freshly-created bucket, never had
          // objects, every class's metric publication lag): leave
          // ARN unmapped — pricing-enricher will fall back to
          // rate-hint display.
        });
      }
    }

    // ── CloudFront distribution tasks (Requests + BytesDownloaded) ─
    {
      const client = clients.get(cloudfrontRegion);
      if (client) {
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - CLOUDFRONT_LOOKBACK_MS);
        for (const dist of distributions) {
          const arn = dist.arn!;
          const id = distributionIdFromArn(arn);
          if (!id) continue;
          tasks.push(async () => {
            // Fan-out the two metric reads in parallel inside the task
            // so a single distribution costs one wall-clock slot in the
            // bounded queue rather than two. Per-metric failures don't
            // abort the other (Promise.allSettled) — but if EITHER
            // metric fails the whole resource is dropped (no partial
            // entries, simpler downstream contract).
            try {
              const [requestsResp, bytesResp] = await Promise.all([
                client.send(
                  new GetMetricStatisticsCommand({
                    Namespace: "AWS/CloudFront",
                    MetricName: "Requests",
                    Dimensions: [
                      { Name: "DistributionId", Value: id },
                      { Name: "Region", Value: "Global" },
                    ],
                    StartTime: startTime,
                    EndTime: endTime,
                    Period: CLOUDFRONT_PERIOD_SECONDS,
                    Statistics: ["Sum"],
                  }),
                ),
                client.send(
                  new GetMetricStatisticsCommand({
                    Namespace: "AWS/CloudFront",
                    MetricName: "BytesDownloaded",
                    Dimensions: [
                      { Name: "DistributionId", Value: id },
                      { Name: "Region", Value: "Global" },
                    ],
                    StartTime: startTime,
                    EndTime: endTime,
                    Period: CLOUDFRONT_PERIOD_SECONDS,
                    Statistics: ["Sum"],
                  }),
                ),
              ]);
              const requests = sumDatapoints(requestsResp.Datapoints);
              const bytes = sumDatapoints(bytesResp.Datapoints);
              result.set(arn, {
                cloudfrontRequestsPerMonth: requests,
                cloudfrontBytesPerMonth: bytes / BYTES_PER_GB,
              });
            } catch {
              // Per-distribution failure (IAM denial, deleted distribution,
              // throttle): same silent-skip contract as S3.
            }
          });
        }
      }
    }

    // try/finally around the runner so an unexpected throw from inside
    // `runWithConcurrency` (defensive — it shouldn't, all per-task
    // errors are swallowed) still triggers client cleanup (Quinn M1).
    try {
      await runWithConcurrency(tasks, concurrency);
    } finally {
      // Best-effort cleanup of underlying connections. SDK clients hold
      // an http handler pool; explicit destroy releases keep-alive
      // sockets so the CLI process can exit promptly.
      for (const c of clients.values()) {
        try {
          c.destroy();
        } catch {
          // ignore — process exit will reap anyway
        }
      }
    }

    return result;
  };
}

/**
 * Returns the most-recent datapoint by timestamp. CloudWatch returns
 * datapoints unordered; sorting by Timestamp DESC and taking the
 * first works regardless of array order or count (1 datapoint per
 * day with a 2-day window means typically 1-3 items).
 */
function pickLatestDatapoint(
  datapoints: Datapoint[] | undefined,
): Datapoint | undefined {
  if (!datapoints || datapoints.length === 0) return undefined;
  const sorted = [...datapoints].sort((a, b) => {
    const ta = a.Timestamp ? a.Timestamp.getTime() : 0;
    const tb = b.Timestamp ? b.Timestamp.getTime() : 0;
    return tb - ta;
  });
  return sorted[0];
}

/**
 * Sum the `Sum` field across every datapoint. CloudFront metrics are
 * read with `Statistics: ["Sum"]` and daily bucketing — totalling the
 * per-day Sums yields the 30-day cumulative count (Requests) or byte
 * volume (BytesDownloaded).
 *
 * Returns 0 for an empty / undefined array — meaning "zero observed
 * traffic" rather than "no data". The consumer treats a zero value
 * as a "no usable multiplier" signal and falls back to the rate-hint
 * display (per `ResourceUsage` field contract).
 */
function sumDatapoints(datapoints: Datapoint[] | undefined): number {
  if (!datapoints || datapoints.length === 0) return 0;
  let total = 0;
  for (const dp of datapoints) {
    if (typeof dp.Sum === "number") total += dp.Sum;
  }
  return total;
}

/**
 * Run tasks with bounded parallelism. Errors thrown by individual
 * tasks are swallowed (the task wrappers above already swallow
 * per-resource failures); this helper assumes the same.
 */
async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const idx = cursor++;
      const task = tasks[idx];
      if (task) {
        try {
          await task();
        } catch {
          // Per-task failures are already handled inside the task
          // wrappers. Defensive catch here so one rogue task can't
          // poison the worker pool.
        }
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}
