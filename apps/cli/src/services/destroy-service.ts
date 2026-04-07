/**
 * destroy-service.ts — Reusable destroy logic extracted from the destroy command.
 *
 * Provides a `destroySingleResource()` function that handles:
 * - CloudControl API deletion with polling
 * - SDK fallback for EventSourceMapping, SNS Subscription, SNS Topic
 * - Pre-delete hooks (DynamoDB deletion protection)
 * - Redirect types (returns error)
 *
 * Returns a structured DestroyResult instead of throwing, making it
 * suitable for both single-resource and bulk-destroy workflows.
 *
 * @see Story 36.1
 */

import {
  CCAPI_FALLBACK_TYPES,
  CCAPI_REDIRECT_TYPES,
  RESOURCE_TYPES,
} from "@assignee/core";
import { createCloudControlClient } from "./cloudcontrol-client.js";
import type { AwsConfig } from "./cloudcontrol-client.js";
import { CloudControlAdapter } from "./cloudcontrol-adapter.js";
import { SDKFallbackDispatcher } from "./sdk-fallback-dispatcher.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "../config/aws-credentials.js";
import {
  AWS_REGION,
  DESTROY_MAX_POLL_ATTEMPTS,
  DESTROY_POLL_INTERVAL_MS,
} from "../config/constants.js";

/**
 * Structured warn-level log line for non-fatal failures inside the destroy
 * pipeline. destroy-service has no LangGraph runId plumbed in, so we emit a
 * plain JSON object on stderr (matching the shape of the main logger) rather
 * than depending on ../utils/logger.ts which requires an action enum value.
 */
function warnDestroy(action: string, extras: Record<string, unknown>): void {
  try {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        source: "destroy-service",
        action,
        extras,
      }) + "\n",
    );
  } catch {
    // stderr write failures are swallowed — never let logging break destroy.
  }
}

/**
 * CloudFront distribution disable polling parameters.
 * CloudFront "in-progress" transitions routinely take 15+ minutes; we allow
 * up to 30 minutes before giving up. Each poll sleeps POLL_INTERVAL_MS.
 */
const CLOUDFRONT_DISABLE_MAX_ATTEMPTS = 360; // 360 * 5s = 30 min
const CLOUDFRONT_POLL_INTERVAL_MS = 5000;
/** Max consecutive transient errors from cf.send(GetDistribution) before aborting. */
const CLOUDFRONT_MAX_TRANSIENT_ERRORS = 5;

const MAX_POLL_ATTEMPTS = DESTROY_MAX_POLL_ATTEMPTS;
const POLL_INTERVAL_MS = DESTROY_POLL_INTERVAL_MS;

/** AWS CloudControl API operation status values. */
const CCAPIStatus = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
} as const;

export interface DestroyResult {
  success: boolean;
  resourceType: string;
  identifier: string;
  arn: string;
  error?: string;
}

export interface DestroyOptions {
  region?: string;
  silent?: boolean; // suppress spinner/output for bulk mode
  onProgress?: (message: string) => void;
}

/**
 * Polls for delete completion using the CloudControlAdapter's getRequestStatus method.
 */
async function pollDeleteStatus(
  adapter: CloudControlAdapter,
  requestToken: string,
): Promise<{ success: boolean; message?: string }> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const [err, status] = await adapter.getRequestStatus(requestToken);
    if (err) {
      return { success: false, message: err.message };
    }

    if (status.operationStatus === CCAPIStatus.SUCCESS) {
      return { success: true };
    }
    if (status.operationStatus === CCAPIStatus.FAILED) {
      return {
        success: false,
        message: status.statusMessage ?? "Delete operation failed",
      };
    }

    // IN_PROGRESS — wait and poll again
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { success: false, message: "Delete operation timed out" };
}

/**
 * Destroys a single AWS resource via CloudControl API or SDK fallback.
 *
 * Returns a structured result instead of throwing, making it composable
 * for both interactive single-destroy and bulk-destroy flows.
 */
export async function destroySingleResource(
  resource: {
    arn: string;
    resourceType: string;
    identifier: string;
    region: string;
  },
  options?: DestroyOptions,
): Promise<DestroyResult> {
  const baseResult: Pick<DestroyResult, "resourceType" | "identifier" | "arn"> =
    {
      resourceType: resource.resourceType,
      identifier: resource.identifier,
      arn: resource.arn,
    };

  const resourceType = resource.resourceType;

  // ── Redirect types cannot be deleted ─────────────────────────────────
  if (CCAPI_REDIRECT_TYPES[resourceType]) {
    return {
      ...baseResult,
      success: false,
      error: `${resourceType} cannot be deleted through assignee.ai. This resource type requires manual deletion.`,
    };
  }

  // ── Resolve AWS credentials ──────────────────────────────────────────
  const awsConfig: AwsConfig = {
    ...operatorCredentials(),
    ...(options?.region ? { region: options.region } : {}),
  };

  // ── SDK fallback for CCAPI gap types ─────────────────────────────────
  if (
    resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING ||
    resourceType === CCAPI_FALLBACK_TYPES.SNS_SUBSCRIPTION ||
    resourceType === RESOURCE_TYPES.SNS_TOPIC
  ) {
    try {
      const dispatcher = new SDKFallbackDispatcher(awsConfig);

      let deleteResult;
      if (resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING) {
        deleteResult = await dispatcher.deleteEventSourceMapping(
          resource.identifier,
        );
      } else if (resourceType === RESOURCE_TYPES.SNS_TOPIC) {
        // SNS Topic delete via CloudControl fails with invalid TopicArn format.
        // Use native SDK DeleteTopicCommand instead.
        deleteResult = await dispatcher.deleteTopic(resource.arn);
      } else {
        deleteResult = await dispatcher.unsubscribe(resource.arn);
      }

      const [deleteErr] = deleteResult;
      if (deleteErr) {
        return {
          ...baseResult,
          success: false,
          error: `Failed to destroy resource: ${deleteErr.message}`,
        };
      }

      return { ...baseResult, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...baseResult,
        success: false,
        error: `Failed to destroy resource: ${message}`,
      };
    }
  }

  // ── CloudFront distribution: disable then delete (SDK only) ──────────
  if (resourceType === "AWS::CloudFront::Distribution") {
    try {
      const {
        CloudFrontClient,
        GetDistributionCommand,
        UpdateDistributionCommand,
        DeleteDistributionCommand,
      } = await import("@aws-sdk/client-cloudfront");
      if (!awsConfig.accessKeyId || !awsConfig.secretAccessKey) {
        return {
          ...baseResult,
          success: false,
          error: "Missing AWS credentials for resource cleanup",
        };
      }
      const cf = new CloudFrontClient({
        region: awsConfig.region ?? AWS_REGION,
        credentials: {
          accessKeyId: awsConfig.accessKeyId,
          secretAccessKey: awsConfig.secretAccessKey,
        },
      });

      // Step 1: Get current config + ETag
      const getResp = await cf.send(
        new GetDistributionCommand({ Id: resource.identifier }),
      );
      const config = getResp.Distribution?.DistributionConfig;
      const etag = getResp.ETag;
      if (!config || !etag) {
        return {
          ...baseResult,
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
          await new Promise((r) => setTimeout(r, CLOUDFRONT_POLL_INTERVAL_MS));
          options?.onProgress?.(
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
            warnDestroy("cloudfront_poll_transient_error", {
              identifier: resource.identifier,
              attempt: i + 1,
              consecutive: consecutiveTransientErrors,
              error:
                pollErr instanceof Error ? pollErr.message : String(pollErr),
            });
            if (consecutiveTransientErrors >= CLOUDFRONT_MAX_TRANSIENT_ERRORS) {
              return {
                ...baseResult,
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
            return { ...baseResult, success: true };
          }
          if (distStatus && distStatus !== "InProgress") {
            return {
              ...baseResult,
              success: false,
              error: `CloudFront disable failed with status: ${distStatus}`,
            };
          }
        }
        return {
          ...baseResult,
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
      return { ...baseResult, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...baseResult,
        success: false,
        error: `CloudFront destroy failed: ${message}`,
      };
    }
  }

  // ── Pre-delete hooks ─────────────────────────────────────────────────
  // DynamoDB: disable deletion protection before deleting
  if (resourceType === RESOURCE_TYPES.DYNAMODB_TABLE) {
    try {
      const { DynamoDBClient, UpdateTableCommand } =
        await import("@aws-sdk/client-dynamodb");
      const ddb = new DynamoDBClient({
        region: awsConfig.region ?? AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      await ddb.send(
        new UpdateTableCommand({
          TableName: resource.identifier,
          DeletionProtectionEnabled: false,
        }),
      );
    } catch (err) {
      // Surface missing-credentials errors clearly — never let them be
      // silently swallowed, or the subsequent CloudControl DeleteResource
      // fails with a confusing ResourceInUseException.
      if (err instanceof MissingAssigneeCredentialsError) {
        return {
          ...baseResult,
          success: false,
          error: `Cannot disable DynamoDB deletion protection: ${err.message}`,
        };
      }
      // Non-fatal: table may not have deletion protection enabled, or the
      // role may lack dynamodb:UpdateTable. Log and continue — the main
      // CloudControl delete path below will surface a clean error if the
      // table actually *is* protected.
      warnDestroy("dynamodb_disable_protection_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // S3: empty bucket before deleting (buckets with objects cannot be destroyed)
  if (resourceType === RESOURCE_TYPES.S3_BUCKET) {
    try {
      const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } =
        await import("@aws-sdk/client-s3");
      const s3 = new S3Client({
        region: awsConfig.region ?? AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });

      // Delete all object versions and delete markers (paginated)
      let isTruncated = true;
      let batch = 0;
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      while (isTruncated) {
        batch++;
        options?.onProgress?.(`Emptying S3 bucket (batch ${batch})...`);
        const versions = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: resource.identifier,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        );
        const objects = [
          ...(versions.Versions ?? []).map((v) => ({
            Key: v.Key!,
            VersionId: v.VersionId,
          })),
          ...(versions.DeleteMarkers ?? []).map((m) => ({
            Key: m.Key!,
            VersionId: m.VersionId,
          })),
        ].filter((o) => o.Key);

        if (objects.length > 0) {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: resource.identifier,
              Delete: { Objects: objects },
            }),
          );
        }
        isTruncated = versions.IsTruncated ?? false;
        keyMarker = versions.NextKeyMarker;
        versionIdMarker = versions.NextVersionIdMarker;
      }
    } catch (err) {
      // Surface missing-credentials errors clearly — swallowing them here
      // causes the downstream CloudControl DeleteResource to fail with an
      // opaque BucketNotEmpty-style error.
      if (err instanceof MissingAssigneeCredentialsError) {
        return {
          ...baseResult,
          success: false,
          error: `Cannot empty S3 bucket before delete: ${err.message}`,
        };
      }
      // Non-fatal: bucket may already be empty, or the role may lack
      // s3:ListBucketVersions / s3:DeleteObject on it. Log and continue.
      warnDestroy("s3_empty_bucket_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Default: CloudControl API ────────────────────────────────────────
  try {
    const ccClient = createCloudControlClient(awsConfig);
    const adapter = new CloudControlAdapter(ccClient);

    const [deleteErr, deleteResult] = await adapter.deleteResource(
      resourceType,
      resource.identifier,
    );

    if (deleteErr) {
      return {
        ...baseResult,
        success: false,
        error: `Failed to destroy resource: ${deleteErr.message}`,
      };
    }

    // Poll for delete completion
    const pollResult = await pollDeleteStatus(
      adapter,
      deleteResult.requestToken,
    );

    if (!pollResult.success) {
      return {
        ...baseResult,
        success: false,
        error: `Destroy failed: ${pollResult.message}`,
      };
    }

    return { ...baseResult, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...baseResult,
      success: false,
      error: `Failed to destroy resource: ${message}`,
    };
  }
}
