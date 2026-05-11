/**
 * S3 Public Website Policy — sets a public-read bucket policy for
 * static website hosting.
 *
 * T2-1: extracted from `s3-upload.ts` (which is named for file-upload
 * concerns, not policy concerns). The companion
 * `s3-compensating-bucket-policy.ts` already shows the per-policy-
 * concern split pattern; this file follows the same convention.
 *
 * The export is also re-exported from `s3-upload.ts` (backwards-compat
 * shim) so existing importers that pin `from "../s3-upload.js"` are
 * unaffected.
 *
 * @see Story 37.3 — S3 Static Site Upload
 * @see s3-compensating-bucket-policy.ts — operator-scoped bucket policy
 */

import { S3Client, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import { IamEffect } from "../config/iam-effects.js";
import { getPartitionFromRegion } from "../config/aws-partition.js";
import { requireAssigneeCredentials } from "../config/aws-credentials.js";
import { EnvVar } from "../constants/env-vars.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";
import { ConfigurationError } from "../errors.js";

/**
 * Configure a public-read bucket policy for static website hosting.
 *
 * Allows anonymous GET requests on all objects in the bucket, which is
 * required for S3 website hosting to serve files to browsers.
 *
 * @param bucketName - Target S3 bucket name
 * @param options    - Optional region override
 */
export async function configureBucketPolicy(
  bucketName: string,
  options?: { region?: string; config?: ConfigPort },
): Promise<void> {
  const effectiveConfig = options?.config ?? new ProcessEnvConfigAdapter();
  const resolvedRegion =
    options?.region ?? effectiveConfig.get(EnvVar.AWS_REGION)?.trim() ?? "";
  if (!resolvedRegion) {
    throw new ConfigurationError(
      "AWS_REGION is missing or empty — set it in .env (or pass an explicit region) before running setup.",
    );
  }
  const client = new S3Client({
    region: resolvedRegion,
    credentials: requireAssigneeCredentials("operator", effectiveConfig),
  });

  // Partition-aware ARN: S3 bucket policies in GovCloud/China reject
  // `arn:aws:` resource ARNs because IAM evaluates the partition literal
  // against the caller's partition. Resolve from the caller's region
  // (options.region > AWS_REGION env var) so GovCloud/China operators
  // emit `arn:aws-us-gov:s3:::...` / `arn:aws-cn:s3:::...` policies.
  const partition = getPartitionFromRegion(resolvedRegion);

  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicReadGetObject",
        Effect: IamEffect.ALLOW,
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:${partition}:s3:::${bucketName}/*`,
      },
    ],
  };

  await client.send(
    new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(policy),
    }),
  );
}
