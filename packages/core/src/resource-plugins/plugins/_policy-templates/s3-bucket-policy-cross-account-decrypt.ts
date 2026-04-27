/**
 * S3-BucketPolicy preset: cross-account-decrypt.
 *
 * Grants a specific cross-account principal (IAM user / role / account
 * root) GetObject access on the bucket and its objects. When the bucket
 * is encrypted with a customer-managed KMS key, the consumer also needs
 * a kms:Decrypt allow on that key — granted on the KMS key resource
 * policy, not here. This template is the bucket half only.
 *
 * Two placeholders:
 *   - <BUCKET_NAME>      — the bucket the policy attaches to.
 *   - <CROSS_ACCOUNT_ARN> — the consumer principal ARN
 *     (e.g. arn:aws:iam::OTHER_ACCOUNT_ID:role/DataConsumer).
 *
 * @see MASTER-011 part C.
 */

export const BUCKET_NAME_PLACEHOLDER = "REPLACE_WITH_BUCKET_NAME";
export const CROSS_ACCOUNT_ARN_PLACEHOLDER =
  "arn:aws:iam::REPLACE_WITH_OTHER_ACCOUNT_ID:role/REPLACE_WITH_ROLE_NAME";

export function buildCrossAccountDecryptPolicy(): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowCrossAccountRead",
        Effect: "Allow",
        Principal: { AWS: CROSS_ACCOUNT_ARN_PLACEHOLDER },
        Action: ["s3:GetObject", "s3:ListBucket"],
        Resource: [
          `arn:aws:s3:::${BUCKET_NAME_PLACEHOLDER}`,
          `arn:aws:s3:::${BUCKET_NAME_PLACEHOLDER}/*`,
        ],
      },
    ],
  };
}
