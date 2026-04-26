/**
 * CloudFront Distribution destroy strategy — full CCAPI bypass.
 *
 * CloudFront requires a three-step dance:
 *   1. GetDistribution to capture the current DistributionConfig + ETag.
 *   2. If Enabled=true, UpdateDistribution to disable, then poll
 *      GetDistribution until Status="Deployed" (routinely 15+ minutes;
 *      we cap at 30 minutes).
 *   3. DeleteDistribution with the latest ETag.
 *
 * Transient errors from GetDistribution during the disable poll are
 * retried up to CLOUDFRONT_MAX_TRANSIENT_ERRORS consecutive times
 * before aborting.
 *
 * @see Wave-6 F1b (CLI origin)
 * @see Story 50-4 — extraction into @assignee/core
 */

import { RESOURCE_TYPES } from "../../config/resource-types/named.js";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "../../config/aws-credentials.js";
import { DEFAULT_AWS_REGION } from "../../config/config-schema.js";
import type { DestroyStrategy } from "../types.js";

/**
 * CloudFront distribution disable polling parameters.
 * CloudFront "in-progress" transitions routinely take 15+ minutes; we allow
 * up to 30 minutes before giving up. Each poll sleeps POLL_INTERVAL_MS.
 */
const CLOUDFRONT_DISABLE_MAX_ATTEMPTS = 360; // 360 * 5s = 30 min
const CLOUDFRONT_POLL_INTERVAL_MS = 5000;
/** Max consecutive transient errors from cf.send(GetDistribution) before aborting. */
const CLOUDFRONT_MAX_TRANSIENT_ERRORS = 5;

export const cloudfrontDistributionStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  async destroy(ctx) {
    const { resource, awsConfig, onProgress } = ctx;
    try {
      const {
        CloudFrontClient,
        GetDistributionCommand,
        UpdateDistributionCommand,
        DeleteDistributionCommand,
      } = await import("@aws-sdk/client-cloudfront");
      // L-A12: use requireAssigneeCredentials("operator") for a
      // consistent error on missing credentials (throws MissingAssigneeCredentialsError).
      let cfCreds;
      try {
        cfCreds = requireAssigneeCredentials("operator");
      } catch (credErr) {
        if (credErr instanceof MissingAssigneeCredentialsError) {
          return {
            success: false,
            error: `Missing AWS credentials for resource cleanup: ${credErr.message}`,
          };
        }
        throw credErr;
      }
      const cf = new CloudFrontClient({
        region: awsConfig.region ?? DEFAULT_AWS_REGION,
        credentials: cfCreds,
      });
      try {
        // Step 1: Get current config + ETag
        const getResp = await cf.send(
          new GetDistributionCommand({ Id: resource.identifier }),
        );
        const config = getResp.Distribution?.DistributionConfig;
        const etag = getResp.ETag;
        if (!config || !etag) {
          return {
            success: false,
            error: "Could not retrieve distribution config",
          };
        }

        // Step 2: Disable if enabled
        if (config.Enabled) {
          config.Enabled = false;
          await cf.send(
            new UpdateDistributionCommand({
              Id: resource.identifier,
              DistributionConfig: config,
              IfMatch: etag,
            }),
          );
          // Wait for deployment. CloudFront Deployed transitions routinely
          // take 15+ minutes; we allow up to 30 minutes. Transient errors
          // from GetDistribution (throttling, 5xx) are retried up to
          // CLOUDFRONT_MAX_TRANSIENT_ERRORS consecutive times before aborting.
          const maxSec =
            (CLOUDFRONT_DISABLE_MAX_ATTEMPTS * CLOUDFRONT_POLL_INTERVAL_MS) /
            1000;
          let consecutiveTransientErrors = 0;
          for (let i = 0; i < CLOUDFRONT_DISABLE_MAX_ATTEMPTS; i++) {
            await new Promise((r) =>
              setTimeout(r, CLOUDFRONT_POLL_INTERVAL_MS),
            );
            onProgress?.(
              `Disabling CloudFront distribution (${
                ((i + 1) * CLOUDFRONT_POLL_INTERVAL_MS) / 1000
              }s / ~${maxSec}s max)...`,
            );
            let status;
            try {
              status = await cf.send(
                new GetDistributionCommand({ Id: resource.identifier }),
              );
              consecutiveTransientErrors = 0;
            } catch (pollErr) {
              consecutiveTransientErrors++;
              ctx.warn("cloudfront_poll_transient_error", {
                identifier: resource.identifier,
                attempt: i + 1,
                consecutive: consecutiveTransientErrors,
                error:
                  pollErr instanceof Error ? pollErr.message : String(pollErr),
              });
              if (
                consecutiveTransientErrors >= CLOUDFRONT_MAX_TRANSIENT_ERRORS
              ) {
                return {
                  success: false,
                  error: `CloudFront poll failed after ${consecutiveTransientErrors} consecutive transient errors: ${
                    pollErr instanceof Error ? pollErr.message : String(pollErr)
                  }`,
                };
              }
              // Retry on next iteration
              continue;
            }
            const distStatus = status.Distribution?.Status;
            if (distStatus === "Deployed") {
              // Step 3: Delete with latest ETag
              await cf.send(
                new DeleteDistributionCommand({
                  Id: resource.identifier,
                  IfMatch: status.ETag!,
                }),
              );
              return { success: true };
            }
            if (distStatus && distStatus !== "InProgress") {
              return {
                success: false,
                error: `CloudFront disable failed with status: ${distStatus}`,
              };
            }
          }
          return {
            success: false,
            error: `CloudFront disable timed out after ${maxSec / 60} minutes`,
          };
        }

        // Already disabled — delete directly
        await cf.send(
          new DeleteDistributionCommand({
            Id: resource.identifier,
            IfMatch: etag,
          }),
        );
        return { success: true };
      } finally {
        cf.destroy();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `CloudFront destroy failed: ${message}`,
      };
    }
  },
};
