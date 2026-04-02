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
  AWS_REGION,
  DESTROY_MAX_POLL_ATTEMPTS,
  DESTROY_POLL_INTERVAL_MS,
} from "../config/constants.js";

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
        // Wait for deployment (poll up to 10 minutes)
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          options?.onProgress?.(
            `Disabling CloudFront distribution (${(i + 1) * 5}s / ~600s max)...`,
          );
          const status = await cf.send(
            new GetDistributionCommand({ Id: resource.identifier }),
          );
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
          error: "CloudFront disable timed out after 10 minutes",
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
      });
      await ddb.send(
        new UpdateTableCommand({
          TableName: resource.identifier,
          DeletionProtectionEnabled: false,
        }),
      );
    } catch {
      // Non-fatal — table may not have protection enabled
    }
  }

  // S3: empty bucket before deleting (buckets with objects cannot be destroyed)
  if (resourceType === "AWS::S3::Bucket") {
    try {
      const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } =
        await import("@aws-sdk/client-s3");
      if (!awsConfig.accessKeyId || !awsConfig.secretAccessKey) {
        return {
          ...baseResult,
          success: false,
          error: "Missing AWS credentials for resource cleanup",
        };
      }
      const s3 = new S3Client({
        region: awsConfig.region ?? AWS_REGION,
        credentials: {
          accessKeyId: awsConfig.accessKeyId,
          secretAccessKey: awsConfig.secretAccessKey,
        },
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
    } catch {
      // Non-fatal — bucket may already be empty
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
