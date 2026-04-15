/**
 * IAM actions for storage / content-delivery resource types:
 * EFS (FileSystem + MountTarget), CloudFront (Distribution + OAC).
 *
 * Split out of `iam-actions.ts` for SRP.
 */

import { RESOURCE_TYPES } from "../resource-types.js";

export const STORAGE_ACTIONS: Record<string, string[]> = {
  // A1 (2026-04-08): EFS FileSystem minimum-viable set.
  [RESOURCE_TYPES.EFS_FILE_SYSTEM]: [
    "elasticfilesystem:CreateFileSystem",
    "elasticfilesystem:DeleteFileSystem",
    "elasticfilesystem:DescribeFileSystems",
    "elasticfilesystem:DescribeBackupPolicy",
    "elasticfilesystem:DescribeReplicationConfigurations",
    "elasticfilesystem:PutBackupPolicy",
    "elasticfilesystem:TagResource",
    // Encryption: KMS grant creation for customer-managed keys.
    "kms:GenerateDataKeyWithoutPlaintext",
    "kms:CreateGrant",
  ],
  // A1 follow-up: EFS MountTarget minimum-viable.
  [RESOURCE_TYPES.EFS_MOUNT_TARGET]: [
    "elasticfilesystem:CreateMountTarget",
    "elasticfilesystem:DeleteMountTarget",
  ],
  // A14 (2026-04-09): AWS::CloudFront::Distribution first-class.
  [RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION]: [
    "cloudfront:CreateDistribution",
    "cloudfront:CreateDistributionWithTags",
    "cloudfront:UpdateDistribution",
    "cloudfront:DeleteDistribution",
    "cloudfront:GetDistribution",
    "cloudfront:GetDistributionConfig",
    "cloudfront:ListDistributions",
    "cloudfront:ListTagsForResource",
    "cloudfront:TagResource",
    "cloudfront:UntagResource",
  ],
  // (f) 2026-04-09 Task 4b: AWS::CloudFront::OriginAccessControl.
  [RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL]: [
    "cloudfront:CreateOriginAccessControl",
    "cloudfront:GetOriginAccessControl",
    "cloudfront:GetOriginAccessControlConfig",
    "cloudfront:UpdateOriginAccessControl",
    "cloudfront:DeleteOriginAccessControl",
    "cloudfront:ListOriginAccessControls",
  ],
};
