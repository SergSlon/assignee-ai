/**
 * SDK-direct fallback adapter for AWS::S3::Bucket.
 *
 * W5-04 (P055 → L5-S08): Used when CloudControl API (CCAPI) is not available
 * in the operator's partition (aws-cn, aws-us-gov, aws-iso, aws-iso-e) but
 * the S3 service itself is available.
 *
 * Implements a subset of `ProvisioningPort` sufficient for the provisioner
 * orchestrator's create path. The adapter is synchronous-for-S3 because
 * `s3:CreateBucket` is synchronous — no async polling token needed. The
 * return shape uses a synthetic "COMPLETE" requestToken to satisfy the
 * poller contract (poller treats this sentinel as immediate success).
 *
 * Scope / deferral:
 *   - Create only. Delete, update, getResource are not implemented here —
 *     the CCAPI adapter handles those in commercial regions; non-commercial
 *     delete/update is Epic 102+ scope.
 *   - Tags, encryption, versioning, and lifecycle are CCAPI CloudFormation
 *     properties; mapping them from the desired-state JSON to SDK params is
 *     Epic 102+ scope. This adapter creates the bucket with the correct
 *     name and region so the provision record is valid.
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html
 */

import {
  S3Client,
  CreateBucketCommand,
  BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { operatorCredentials } from "../../config/operator-credentials.js";
import { AWS_REGION } from "../../config/constants/aws.js";

/** Synthetic requestToken sentinel — signals immediate success to the poller. */
export const SDK_DIRECT_COMPLETE_TOKEN = "SDK_DIRECT_COMPLETE";

export interface SdkDirectResult {
  requestToken: string;
  identifier: string;
}

/**
 * Creates an S3 bucket via the direct AWS SDK (not CloudControl).
 *
 * @param desiredStateJson - JSON string of CloudFormation desired-state properties.
 *   Must include `"BucketName"` property.
 * @param region           - AWS region for the bucket.
 * @returns SdkDirectResult with a synthetic requestToken + bucket name identifier.
 * @throws Error with actionable message if BucketName is missing or SDK call fails.
 */
export async function createS3BucketSdkDirect(
  desiredStateJson: string,
  region: string = AWS_REGION,
): Promise<SdkDirectResult> {
  let desiredState: Record<string, unknown>;
  try {
    desiredState = JSON.parse(desiredStateJson) as Record<string, unknown>;
  } catch {
    throw new Error(
      `SDK-direct S3 create: desiredState is not valid JSON: ${desiredStateJson.slice(0, 120)}`,
    );
  }

  const bucketName = desiredState["BucketName"];
  if (typeof bucketName !== "string" || !bucketName) {
    throw new Error(
      `SDK-direct S3 create: "BucketName" is required in desiredState but was not found. ` +
        `Provided keys: ${Object.keys(desiredState).join(", ")}`,
    );
  }

  const creds = operatorCredentials();
  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  });

  // us-east-1 does NOT accept a LocationConstraint — it must be omitted.
  const locationConstraint =
    region !== "us-east-1" ? (region as BucketLocationConstraint) : undefined;

  await client.send(
    new CreateBucketCommand({
      Bucket: bucketName,
      ...(locationConstraint
        ? {
            CreateBucketConfiguration: {
              LocationConstraint: locationConstraint,
            },
          }
        : {}),
    }),
  );

  return {
    requestToken: SDK_DIRECT_COMPLETE_TOKEN,
    identifier: bucketName,
  };
}
