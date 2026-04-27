/**
 * S3-BucketPolicy preset: tls-only.
 *
 * Denies every S3 action on the bucket and its objects when the
 * request is not made over TLS (`aws:SecureTransport: false`).
 * AWS's recommended security baseline for any production S3 bucket
 * (Trusted Advisor / Config rule s3-bucket-ssl-requests-only).
 *
 * One placeholder:
 *   - <BUCKET_NAME> — the bucket the policy attaches to.
 *
 * @see MASTER-011 part C.
 */

export const BUCKET_NAME_PLACEHOLDER = "REPLACE_WITH_BUCKET_NAME";

export function buildTlsOnlyPolicy(): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [
          `arn:aws:s3:::${BUCKET_NAME_PLACEHOLDER}`,
          `arn:aws:s3:::${BUCKET_NAME_PLACEHOLDER}/*`,
        ],
        Condition: {
          Bool: { "aws:SecureTransport": "false" },
        },
      },
    ],
  };
}
