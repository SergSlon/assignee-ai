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
 * AWS bills a per-path fee after the monthly free tier — see
 * https://aws.amazon.com/cloudfront/pricing/ for current rates.
 * This service does NOT compute live prices — the `update` command
 * surfaces a pricing-page URL in a stderr log line before invoking.
 * See `feedback_no_hardcoded_prices`.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resp: any;
  try {
    resp = await cf.send(
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
  } catch (err: unknown) {
    // B3 (S-H-010): surface an actionable hint on AccessDeniedException
    // so the operator knows which IAM policy to refresh.
    const name =
      err instanceof Error ? ((err as { name?: string }).name ?? "") : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (
      name === "AccessDeniedException" ||
      msg.includes("cloudfront:CreateInvalidation")
    ) {
      throw new AssigneeError(
        "Operator IAM policy missing cloudfront:CreateInvalidation. Run 'assignee setup' to refresh credentials, or add the grant manually.",
        ErrorCode.PERMISSION_ERROR,
      );
    }
    throw err;
  }
  const respTyped = resp as {
    Invalidation?: { Id?: string; Status?: string };
    $metadata?: { requestId?: string };
  };
  const id = respTyped.Invalidation?.Id;
  const status = respTyped.Invalidation?.Status;
  if (!id) {
    throw new AssigneeError(
      `cloudfront-invalidate: CreateInvalidation returned no Invalidation.Id (request id ${respTyped.$metadata?.requestId ?? "unknown"})`,
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
): Promise<{ status: string; completedAt?: Date; timedOut?: boolean }> {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    try {
      resp = await cf.send(
        new GetInvalidationCommand({
          DistributionId: distributionId,
          Id: invalidationId,
        }),
      );
    } catch (err: unknown) {
      // B3 (S-H-010): surface an actionable hint on AccessDeniedException
      // for GetInvalidation so the operator knows which IAM policy to refresh.
      const name =
        err instanceof Error ? ((err as { name?: string }).name ?? "") : "";
      const msg = err instanceof Error ? err.message : String(err);
      if (
        name === "AccessDeniedException" ||
        msg.includes("cloudfront:GetInvalidation")
      ) {
        throw new AssigneeError(
          "Operator IAM policy missing cloudfront:GetInvalidation. Run 'assignee setup' to refresh credentials, or add the grant manually.",
          ErrorCode.PERMISSION_ERROR,
        );
      }
      throw err;
    }
    const respTyped = resp as {
      Invalidation?: { Status?: string; CreateTime?: Date };
    };
    lastStatus = respTyped.Invalidation?.Status ?? "InProgress";
    if (lastStatus === "Completed") {
      return {
        status: lastStatus,
        completedAt: respTyped.Invalidation?.CreateTime,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // A5 (M-H-011): return a distinct timedOut flag so callers can
  // distinguish a timeout from a legitimate non-Completed terminal
  // status. Previously both paths returned `{ status: lastStatus }`
  // with no way to tell them apart.
  return { status: "TimedOut", timedOut: true };
}
