/**
 * S3 Bucket destroy strategy — preDestroy:
 *   1. Deletes all object versions and delete markers in paginated, chunked
 *      batches (conservative: always runs, safe for non-versioned buckets too).
 *   2. Deletes the companion AWS::S3::BucketPolicy if present in the
 *      provision log (spec line 13 / DC-2).
 *
 * ListObjectVersions can return up to 1000 Versions PLUS up to 1000
 * DeleteMarkers in a single page (2000 combined). DeleteObjects
 * accepts at most 1000 keys per request, so we must chunk.
 *
 * Wave 19 Bug #3: AccessDenied on ListBucketVersions/DeleteObjectVersion
 * is surfaced as a hard failure (was previously swallowed as a warn,
 * causing a confusing downstream BucketNotEmpty error).
 *
 * V1 N5 invariant: truncated-without-marker guard — if the AWS
 * response sets IsTruncated=true but omits BOTH next markers, break
 * out so destroy fails fast instead of spinning forever.
 *
 * @see Wave-6 F1b (CLI origin)
 * @see Story 50-4 — extraction into @assignee/core
 * @see DC-2 — BucketPolicy companion pre-delete
 */

import {
  CloudControlClient,
  DeleteResourceCommand,
  GetResourceRequestStatusCommand,
} from "@aws-sdk/client-cloudcontrol";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "../../config/aws-credentials.js";
import { DEFAULT_AWS_REGION } from "../../config/config-schema.js";
import { isAccessDeniedError } from "../../config/aws-errors.js";
import { listProvisionRecords } from "../../managed-resources/store.js";
import type { DestroyStrategy, DestroyContext } from "../types.js";

/**
 * S3 DeleteObjects accepts at most 1000 keys per request. ListObjectVersions
 * can return up to 1000 Versions plus 1000 DeleteMarkers in a single page —
 * 2000 combined — so the merged array must be chunked before deletion.
 */
const S3_DELETE_OBJECTS_CHUNK_SIZE = 1000;

/** Poll cap: 30 × 2s = 60s max wait for BucketPolicy delete. */
const BUCKET_POLICY_DELETE_MAX_POLL = 30;
const BUCKET_POLICY_DELETE_POLL_MS = 2000;

/**
 * Deletes the companion AWS::S3::BucketPolicy before the bucket itself.
 * The CCAPI primaryIdentifier for BucketPolicy is the bucket name.
 * Non-fatal: a failed delete logs a warn but does not abort the bucket destroy.
 */
async function deleteBucketPolicyCompanion(
  bucketName: string,
  ctx: DestroyContext,
): Promise<void> {
  let records;
  try {
    records = await listProvisionRecords();
  } catch (err) {
    ctx.warn("s3_bucket_policy_companion_lookup_failed", {
      identifier: bucketName,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // BucketPolicy CCAPI identifier == bucket name. Match any record whose
  // key is the bucket name (primaryIdentifier) or whose key ends with the
  // bucket name (e.g. a future ARN-keyed row).
  const companion = records.find(
    (r) =>
      r.resourceType === RESOURCE_TYPES.S3_BUCKET_POLICY &&
      (r.key === bucketName ||
        r.key.endsWith(`/${bucketName}`) ||
        r.key.endsWith(`:${bucketName}`)),
  );
  if (!companion) return;

  ctx.onProgress?.(`Deleting companion BucketPolicy for ${bucketName}...`);

  const { awsConfig } = ctx;
  let ccClient: CloudControlClient | undefined;
  try {
    ccClient = new CloudControlClient({
      region: awsConfig.region ?? DEFAULT_AWS_REGION,
      credentials: {
        accessKeyId: awsConfig.accessKeyId,
        secretAccessKey: awsConfig.secretAccessKey,
        ...(awsConfig.sessionToken
          ? { sessionToken: awsConfig.sessionToken }
          : {}),
      },
    });

    const deleteResult = await ccClient.send(
      new DeleteResourceCommand({
        TypeName: RESOURCE_TYPES.S3_BUCKET_POLICY,
        Identifier: bucketName,
      }),
    );

    const requestToken = deleteResult.ProgressEvent?.RequestToken;
    if (!requestToken) return;

    for (let i = 0; i < BUCKET_POLICY_DELETE_MAX_POLL; i++) {
      const statusResult = await ccClient.send(
        new GetResourceRequestStatusCommand({ RequestToken: requestToken }),
      );
      const status = statusResult.ProgressEvent?.OperationStatus;
      if (status === "SUCCESS") {
        ctx.onProgress?.(`Companion BucketPolicy for ${bucketName} deleted.`);
        return;
      }
      if (status === "FAILED") {
        const errCode = statusResult.ProgressEvent?.ErrorCode ?? "unknown";
        if (errCode === "NotFound") return;
        ctx.warn("s3_bucket_policy_delete_failed", {
          bucketName,
          errorCode: errCode,
          statusMessage: statusResult.ProgressEvent?.StatusMessage ?? "",
        });
        return;
      }
      await new Promise((r) => setTimeout(r, BUCKET_POLICY_DELETE_POLL_MS));
    }

    ctx.warn("s3_bucket_policy_delete_timeout", {
      bucketName,
      hint: `Run \`assignee destroy ${bucketName}\` with resource type AWS::S3::BucketPolicy to clean up manually.`,
    });
  } catch (err) {
    ctx.warn("s3_bucket_policy_delete_error", {
      bucketName,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    ccClient?.destroy();
  }
}

export const s3BucketStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.S3_BUCKET,
  async preDestroy(ctx) {
    const { resource, awsConfig, onProgress } = ctx;

    // Step 1: Delete companion BucketPolicy before emptying + deleting bucket.
    await deleteBucketPolicyCompanion(resource.identifier, ctx);

    // Step 2: Empty the bucket (all object versions + delete markers).
    try {
      const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } =
        await import("@aws-sdk/client-s3");
      const s3 = new S3Client({
        region: awsConfig.region ?? DEFAULT_AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      try {
        // Delete all object versions and delete markers (paginated).
        // Conservative: always runs even for non-versioned buckets — safe
        // because ListObjectVersions on a non-versioned bucket returns
        // objects without VersionId, which DeleteObjects handles correctly.
        let isTruncated = true;
        let batch = 0;
        let keyMarker: string | undefined;
        let versionIdMarker: string | undefined;
        while (isTruncated) {
          batch++;
          onProgress?.(`Emptying S3 bucket (batch ${batch})...`);
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

          // Chunk: DeleteObjects accepts at most 1000 keys per request.
          for (
            let off = 0;
            off < objects.length;
            off += S3_DELETE_OBJECTS_CHUNK_SIZE
          ) {
            const chunk = objects.slice(
              off,
              off + S3_DELETE_OBJECTS_CHUNK_SIZE,
            );
            await s3.send(
              new DeleteObjectsCommand({
                Bucket: resource.identifier,
                Delete: { Objects: chunk },
              }),
            );
          }
          isTruncated = versions.IsTruncated ?? false;
          keyMarker = versions.NextKeyMarker;
          versionIdMarker = versions.NextVersionIdMarker;
          // V1 N5: paranoid guard against infinite loop if AWS sets
          // IsTruncated=true but omits both next markers. Break out so
          // destroy fails fast.
          if (isTruncated && !keyMarker && !versionIdMarker) {
            ctx.warn("s3_list_versions_truncated_without_marker", {
              identifier: resource.identifier,
              batch,
            });
            break;
          }
        }
      } finally {
        s3.destroy();
      }
    } catch (err) {
      if (err instanceof MissingAssigneeCredentialsError) {
        return {
          success: false,
          error: `Cannot empty S3 bucket before delete: ${err.message}`,
        };
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      // Wave 4 F2: structured classifier — promote AccessDenied to a
      // hard failure so the user learns the real cause (missing IAM
      // perm) instead of a second-order CCAPI BucketNotEmpty.
      const isAccessDenied = isAccessDeniedError(err);
      if (isAccessDenied) {
        return {
          success: false,
          error:
            `Cannot empty S3 bucket "${resource.identifier}" before delete — the operator role lacks ` +
            `s3:ListBucketVersions / s3:DeleteObjectVersion. These are already in iam-actions.ts for ` +
            `S3_BUCKET; run \`assignee dev setup\` to refresh AssigneeOperatorPolicy in AWS. ` +
            `Original AWS error: ${errMsg}`,
        };
      }
      // Other failures (network, throttling, empty bucket) — log and continue
      // so destroy still attempts DeleteBucket.
      ctx.warn("s3_empty_bucket_failed", {
        identifier: resource.identifier,
        error: errMsg,
      });
    }
  },
};
