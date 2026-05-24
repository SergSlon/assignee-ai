/**
 * CloudWatch-backed storage enricher for the `assignee admin list` and
 * `assignee infra destroy --all` cost displays.
 *
 * Calls `cloudwatch:GetMetricStatistics` on the `AWS/S3` namespace's
 * `BucketSizeBytes` metric (StandardStorage dimension) for every S3
 * bucket in the input set, converts the most-recent datapoint to GB,
 * and returns a per-ARN `ResourceUsage` map. The pricing-enricher uses
 * this map to multiply the per-GB-month rate by the actual GB volume,
 * promoting the per-unit rate hint into a real `$X.XX/mo` total.
 *
 * Closes F6 from the 2026-05-22 wizard UX audit (CloudFront baseline +
 * non-S3 usage metrics are out-of-scope for this iteration — the
 * enricher is type-extensible via the `ResourceUsage` interface).
 *
 * Per-bucket failure → no entry in the returned map. The caller falls
 * back to the original rate-hint display (zero behavioural regression).
 * Never throws.
 *
 * Cost / latency: `GetMetricStatistics` is $0.01 / 1,000 calls + ~50ms
 * round-trip per call. Bounded concurrency (DEFAULT_CONCURRENCY=10)
 * keeps a 100-bucket account at ~5s wall-clock + $0.001 — well below
 * the listing's existing Pricing-MCP latency budget.
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
import type {
  ResourceUsage,
  StorageEnricher,
} from "../list-resources/fetch-managed-resources.js";

/** Default parallel CloudWatch calls — balances wall-clock vs throttling. */
const DEFAULT_CONCURRENCY = 10;

/** CFN resource type for S3 buckets. Match by exact string. */
const S3_BUCKET_TYPE = "AWS::S3::Bucket";

/**
 * Lookback window. BucketSizeBytes is published once per day around
 * midnight UTC; a 2-day window is the smallest one that reliably has
 * at least one datapoint even on a freshly-created bucket whose
 * first datapoint hasn't published yet (in which case we still return
 * no entry — the caller correctly falls back to rate-hint display).
 */
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/** GetMetricStatistics period. BucketSizeBytes is daily so 86_400 is the
 *  granularity AWS actually returns; smaller values produce zero data. */
const PERIOD_SECONDS = 86_400;

/** AWS billing convention: 1 GB = 10^9 bytes (NOT 2^30). Matches what
 *  the Pricing API rates assume per-GB-month so the multiplication is
 *  self-consistent. */
const BYTES_PER_GB = 1_000_000_000;

/** Extract the bucket name from `arn:aws:s3:::<name>`. Returns null when
 *  the ARN doesn't match the S3 bucket shape (defensive — RGTA should
 *  always give us a valid bucket ARN for S3 resource types). */
function bucketNameFromArn(arn: string): string | null {
  const match = arn.match(/^arn:aws[\w-]*:s3:::(.+?)$/);
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
 */
export function createCloudWatchStorageEnricher(
  credentials: SdkCredentials,
  region: string,
  concurrency: number = DEFAULT_CONCURRENCY,
): StorageEnricher {
  return async (resources: ManagedResource[]) => {
    const result = new Map<string, ResourceUsage>();
    const buckets = resources.filter(
      (r) => r.resourceType === S3_BUCKET_TYPE && r.arn,
    );
    if (buckets.length === 0) return result;

    // Group by the resource's own region — buckets live in different
    // regions even within one account, and CloudWatch metrics are
    // region-scoped. A bucket in eu-west-1 won't surface its
    // BucketSizeBytes from us-east-1.
    const byRegion = new Map<string, ManagedResource[]>();
    for (const b of buckets) {
      const r = b.region === "global" ? region : b.region;
      const bucketsHere = byRegion.get(r) ?? [];
      bucketsHere.push(b);
      byRegion.set(r, bucketsHere);
    }

    // One CloudWatch client per region. Re-using is cheap; tearing down
    // matters less because the enricher exits when the listing finishes.
    const clients = new Map<string, CloudWatchClient>();
    for (const r of byRegion.keys()) {
      clients.set(r, new CloudWatchClient({ region: r, credentials }));
    }

    // Bounded-concurrency queue. We avoid pulling in a dep like
    // p-limit / p-map to keep the surface tight — the queue here is a
    // few lines of plain async code.
    const tasks: Array<() => Promise<void>> = [];
    for (const [bucketRegion, group] of byRegion) {
      const client = clients.get(bucketRegion)!;
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - LOOKBACK_MS);
      for (const bucket of group) {
        const arn = bucket.arn!;
        const name = bucketNameFromArn(arn);
        if (!name) continue;
        tasks.push(async () => {
          try {
            const resp = await client.send(
              new GetMetricStatisticsCommand({
                Namespace: "AWS/S3",
                MetricName: "BucketSizeBytes",
                Dimensions: [
                  { Name: "BucketName", Value: name },
                  { Name: "StorageType", Value: "StandardStorage" },
                ],
                StartTime: startTime,
                EndTime: endTime,
                Period: PERIOD_SECONDS,
                Statistics: ["Average"],
              }),
            );
            const latest = pickLatestDatapoint(resp.Datapoints);
            if (latest?.Average !== undefined) {
              result.set(arn, { storageGB: latest.Average / BYTES_PER_GB });
            }
            // No datapoint (freshly-created bucket, never had objects,
            // metric publication lag): leave ARN unmapped — pricing-
            // enricher will fall back to rate-hint display.
          } catch {
            // Per-bucket failure (IAM denial, bucket deleted mid-list,
            // CloudWatch transient): skip silently. We deliberately
            // don't write to stderr per bucket — a missing-IAM
            // configuration would emit one warning per bucket and
            // drown the CLI output. The pricing-enricher's existing
            // per-tuple warning is enough signal.
          }
        });
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
 * Run tasks with bounded parallelism. Errors thrown by individual
 * tasks are swallowed (the task wrappers above already swallow
 * per-bucket failures); this helper assumes the same.
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
