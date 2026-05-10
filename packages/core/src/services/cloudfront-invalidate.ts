/**
 * CloudFront invalidation service — thin wrappers around
 * `cloudfront:CreateInvalidation` + `cloudfront:GetInvalidation` used
 * by `assignee update` to refresh a CDN cache after the post-upload
 * S3 sync.
 *
 * Why this exists
 * ---------------
 * The static-website compound provisions S3 + CloudFront, but a plain
 * `aws s3 sync` does NOT trigger a CloudFront cache refresh — viewers
 * keep seeing the OLD content until the TTL expires (24h by default
 * for the static-site preset). `assignee update` automates both steps
 * so the user sees fresh content within minutes instead of needing to
 * run a second CLI tool.
 *
 * Pricing reminder
 * ----------------
 * AWS bills $0.005 per path-invalidated AFTER the first 1000 paths/month
 * (free tier). This service does NOT compute live prices — the
 * `update` command surfaces the published formula in a stderr log line
 * before invoking. All dollar amounts come from the AWS public pricing
 * page; the runtime never looks up a live $ value. See
 * `feedback_no_hardcoded_prices`.
 *
 * Lazy SDK loading
 * ----------------
 * `@aws-sdk/client-cloudfront` is dynamically imported per the project
 * convention (mirrors `destroy-strategies/strategies/cloudfront-distribution.ts:47`).
 * Keeps `--help` and non-cloudfront commands free of the SDK's ~1 MB
 * bundle cost.
 */

import { randomUUID } from "node:crypto";
import { AssigneeError } from "../errors.js";
import { ErrorCode } from "../constants/errors.js";
import { requireAssigneeCredentials } from "../config/aws-credentials.js";
import { AWS_REGION } from "../config/constants/aws.js";

export interface InvalidationArgs {
  distributionId: string;
  /** Paths to invalidate. Default: `["/*"]` (entire distribution). */
  paths?: string[];
  /**
   * Idempotency token. AWS treats two CreateInvalidation calls with the
   * SAME CallerReference + DistributionId as a single invalidation. The
   * `assignee update` command passes its runId so re-invocations within
   * the same run do not double-bill.
   */
  callerReference?: string;
  /**
   * AWS region. CloudFront is a global service so this is purely a
   * SDK client hint — defaults to `AWS_REGION` from the env.
   */
  region?: string;
}

export interface InvalidationResult {
  invalidationId: string;
  status: string; // "InProgress" | "Completed"
}

/**
 * Hard cap from AWS — `CreateInvalidation` rejects requests with more
 * than 1000 paths per call.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html#InvalidationLimits
 */
export const MAX_INVALIDATION_PATHS = 1000;

/** Default polling parameters for `waitForInvalidation`. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Create a CloudFront cache invalidation.
 *
 * Validates path count against AWS's 1000-paths-per-request limit. Does
 * NOT poll — pair with `waitForInvalidation` when the caller wants to
 * block until `Status === "Completed"`.
 *
 * Idempotency: passing the same `callerReference` twice returns the
 * same invalidation (AWS's documented behaviour).
 */
export async function createInvalidation(
  args: InvalidationArgs,
): Promise<InvalidationResult> {
  const paths = args.paths && args.paths.length > 0 ? args.paths : ["/*"];
  if (paths.length > MAX_INVALIDATION_PATHS) {
    throw new AssigneeError(
      `cloudfront-invalidate: max ${MAX_INVALIDATION_PATHS} invalidation paths per request — you supplied ${paths.length}. Split the request into multiple invalidations.`,
      ErrorCode.USAGE_ERROR,
    );
  }

  const { CloudFrontClient, CreateInvalidationCommand } =
    await import("@aws-sdk/client-cloudfront");
  const cf = new CloudFrontClient({
    region: args.region ?? AWS_REGION,
    credentials: requireAssigneeCredentials("operator"),
  });
  const resp = await cf.send(
    new CreateInvalidationCommand({
      DistributionId: args.distributionId,
      InvalidationBatch: {
        CallerReference: args.callerReference ?? randomUUID(),
        Paths: {
          Quantity: paths.length,
          Items: [...paths],
        },
      },
    }),
  );
  const id = resp.Invalidation?.Id;
  const status = resp.Invalidation?.Status;
  if (!id) {
    throw new AssigneeError(
      `cloudfront-invalidate: CreateInvalidation returned no Invalidation.Id (request id ${resp.$metadata?.requestId ?? "unknown"})`,
      ErrorCode.UNKNOWN,
    );
  }
  return { invalidationId: id, status: status ?? "InProgress" };
}

/**
 * Poll `GetInvalidation` until `Status === "Completed"` or the timeout
 * elapses. Default 5s interval, 10 minute hard cap (typical
 * invalidations complete in 1-5 min; the cap protects against hung
 * waits if CloudFront's edge propagation stalls).
 *
 * Mirrors the polling pattern in
 * `destroy-strategies/strategies/cloudfront-distribution.ts` (the
 * disable poll), with shorter intervals because invalidations
 * complete much faster than distribution disables.
 */
export async function waitForInvalidation(
  distributionId: string,
  invalidationId: string,
  options?: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    region?: string;
  },
): Promise<{ status: string; completedAt?: Date }> {
  const intervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { CloudFrontClient, GetInvalidationCommand } =
    await import("@aws-sdk/client-cloudfront");
  const cf = new CloudFrontClient({
    region: options?.region ?? AWS_REGION,
    credentials: requireAssigneeCredentials("operator"),
  });

  const startedAt = Date.now();
  let lastStatus = "InProgress";
  while (Date.now() - startedAt < timeoutMs) {
    const resp = await cf.send(
      new GetInvalidationCommand({
        DistributionId: distributionId,
        Id: invalidationId,
      }),
    );
    lastStatus = resp.Invalidation?.Status ?? "InProgress";
    if (lastStatus === "Completed") {
      return {
        status: lastStatus,
        completedAt: resp.Invalidation?.CreateTime,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: lastStatus };
}
