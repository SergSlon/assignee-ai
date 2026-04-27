/**
 * S3-BucketPolicy preset: cloudfront-oac-read.
 *
 * Grants a specific CloudFront distribution (identified by SourceArn)
 * GetObject access on the bucket via the cloudfront.amazonaws.com
 * service principal. The `aws:SourceArn` Condition pin is mandatory
 * — without it any CloudFront distribution in any account could
 * read the bucket. This is the "OAC pattern" for private S3 origins.
 *
 * Two placeholders the user is expected to replace before apply
 * (or compound-resolved via markerRef substitution):
 *   - <BUCKET_NAME>      — the bucket the policy attaches to
 *   - <DISTRIBUTION_ARN> — the CloudFront distribution ARN
 *
 * @see MASTER-011 part C.
 */

export const BUCKET_NAME_PLACEHOLDER = "REPLACE_WITH_BUCKET_NAME";
export const DISTRIBUTION_ARN_PLACEHOLDER =
  "arn:aws:cloudfront::REPLACE_WITH_ACCOUNT_ID:distribution/REPLACE_WITH_DISTRIBUTION_ID";

export function buildCloudFrontOacReadPolicy(): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowCloudFrontServicePrincipalRead",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${BUCKET_NAME_PLACEHOLDER}/*`,
        Condition: {
          StringEquals: {
            "AWS:SourceArn": DISTRIBUTION_ARN_PLACEHOLDER,
          },
        },
      },
    ],
  };
}
