/**
 * IAM actions required by S3-family resource types (S3::Bucket, S3::BucketPolicy).
 * Split out of `iam-actions.ts` for SRP / file-size compliance.
 */

import { RESOURCE_TYPES } from "../resource-types.js";

export const S3_ACTIONS: Record<string, string[]> = {
  [RESOURCE_TYPES.S3_BUCKET]: [
    "s3:CreateBucket",
    "s3:DeleteBucket",
    "s3:GetBucket*",
    "s3:PutBucket*",
    "s3:DeleteBucketWebsite",
    "s3:GetEncryptionConfiguration",
    "s3:PutEncryptionConfiguration",
    "s3:GetLifecycleConfiguration",
    "s3:PutLifecycleConfiguration",
    "s3:GetReplicationConfiguration",
    "s3:PutReplicationConfiguration",
    "s3:GetIntelligentTieringConfiguration",
    "s3:PutIntelligentTieringConfiguration",
    "s3:PutObject",
    "s3:GetObject",
    "s3:DeleteObject",
    // Required by destroy-service.ts to enumerate ALL objects in the bucket
    // (both versioned and non-versioned) before bulk-deleting. s3:ListBucket
    // is the permission for ListObjectsV2 (non-versioned listing); without it
    // the pre-delete sweep cannot see unversioned objects.
    "s3:ListBucket",
    // Required by destroy-service.ts to enumerate and delete versioned
    // objects and delete markers before bulk-deleting a versioned bucket.
    "s3:ListBucketVersions",
    "s3:DeleteObjectVersion",
    // CloudFront for static websites (Epic 37)
    "cloudfront:CreateDistribution",
    "cloudfront:CreateOriginAccessControl",
    "cloudfront:GetDistribution",
    "cloudfront:GetDistributionConfig",
    "cloudfront:UpdateDistribution",
    "cloudfront:DeleteDistribution",
    "cloudfront:TagResource",
  ],
  // (f) 2026-04-09 Task 4b: AWS::S3::BucketPolicy.
  // s3:PutBucketPolicy and s3:DeleteBucketPolicy are new net bytes.
  // s3:GetBucketPolicy folds into the existing s3:Get* wildcard.
  [RESOURCE_TYPES.S3_BUCKET_POLICY]: [
    "s3:GetBucketPolicy",
    "s3:PutBucketPolicy",
    "s3:DeleteBucketPolicy",
  ],
};
