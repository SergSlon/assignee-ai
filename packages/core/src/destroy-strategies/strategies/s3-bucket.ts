/**
 * S3 Bucket destroy strategy — preDestroy empties all object versions
 * and delete markers in paginated, chunked batches before CCAPI
 * DeleteBucket.
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
 */

import { RESOURCE_TYPES } from "../../config/resource-types/named.js";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "../../config/aws-credentials.js";
import { DEFAULT_AWS_REGION } from "../../config/config-schema.js";
import { isAccessDeniedError } from "../../config/aws-errors.js";
import type { DestroyStrategy } from "../types.js";
import { warnDestroy } from "../warn.js";

/**
 * S3 DeleteObjects accepts at most 1000 keys per request. ListObjectVersions
 * can return up to 1000 Versions plus 1000 DeleteMarkers in a single page —
 * 2000 combined — so the merged array must be chunked before deletion.
 */
const S3_DELETE_OBJECTS_CHUNK_SIZE = 1000;

export const s3BucketStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.S3_BUCKET,
  async preDestroy(ctx) {
    const { resource, awsConfig, onProgress } = ctx;
    try {
      const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } =
        await import("@aws-sdk/client-s3");
      const s3 = new S3Client({
        region: awsConfig.region ?? DEFAULT_AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      try {
        // Delete all object versions and delete markers (paginated)
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
            warnDestroy("s3_list_versions_truncated_without_marker", {
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
            `S3_BUCKET; run \`assignee setup\` to refresh AssigneeOperatorPolicy in AWS. ` +
            `Original AWS error: ${errMsg}`,
        };
      }
      // Other failures (network, throttling, empty bucket) — log and continue
      // so destroy still attempts DeleteBucket.
      warnDestroy("s3_empty_bucket_failed", {
        identifier: resource.identifier,
        error: errMsg,
      });
    }
  },
};
