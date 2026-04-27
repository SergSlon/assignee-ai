/**
 * S3-BucketPolicy preset: public-read (with IP allowlist).
 *
 * Grants anonymous (`Principal: "*"`) GetObject access on the bucket
 * objects, scoped by an `aws:SourceIp` Condition to a CIDR allowlist.
 * Use sparingly — public buckets are a common breach vector. Most
 * "public website" cases should use the cloudfront-oac-read preset
 * with a private bucket fronted by CloudFront instead.
 *
 * Two placeholders:
 *   - <BUCKET_NAME>     — the bucket the policy attaches to.
 *   - <ALLOWED_CIDR>    — IP allowlist CIDR (default 0.0.0.0/0 matches
 *     all of IPv4; tighten this in the wizard input).
 *
 * @see MASTER-011 part C.
 */

export const BUCKET_NAME_PLACEHOLDER = "REPLACE_WITH_BUCKET_NAME";
export const ALLOWED_CIDR_PLACEHOLDER = "0.0.0.0/0";

export function buildPublicReadPolicy(): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicReadFromAllowedCidr",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${BUCKET_NAME_PLACEHOLDER}/*`,
        Condition: {
          IpAddress: {
            "aws:SourceIp": ALLOWED_CIDR_PLACEHOLDER,
          },
        },
      },
    ],
  };
}
