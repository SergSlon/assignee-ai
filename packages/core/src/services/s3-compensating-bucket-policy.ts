/**
 * S3 Compensating Bucket Policy — attaches a resource-based bucket policy
 * that grants the Assignee operator destructive actions on the bucket,
 * conditional on the bucket carrying the `managed-by=assignee-ai` tag.
 *
 * ## Why this exists (AWS S3 IAM limitation)
 *
 * AWS does NOT auto-populate `aws:ResourceTag` into the IAM request-evaluation
 * context for S3 *bucket-level* destructive operations (`s3:DeleteBucket`,
 * `s3:DeleteBucketPolicy`). A tag-scoped `Allow` statement in the operator's
 * IAM identity policy always evaluates to `implicitDeny` — as if the tag
 * were absent — regardless of whether the bucket actually carries the tag.
 *
 * **Resource-based bucket policies do evaluate `aws:ResourceTag` correctly
 * for bucket-level operations.** Attaching a compensating bucket policy at
 * create-time restores the per-bucket tag boundary:
 *   - Only buckets that Assignee provisioned (and therefore have this
 *     compensating policy) grant the operator destructive permissions.
 *   - Non-Assignee buckets retain their existing deny-by-default posture.
 *   - An admin can still override via an explicit Deny in their own policy
 *     (the compensating policy is purely `Allow`; explicit Deny always wins).
 *
 * Reference:
 *   AWS re:Post — https://repost.aws/questions/QUyMnHQq6oTdyx76CMRhZ4yA
 *   Full analysis: docs/explanation/security-model.md
 *                  §S3 bucket-level IAM limitation
 *   Bug story:     bug-s3-destructive-tag-condition-aws-limitation.md (Part 2)
 */

import { S3Client, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import { IamEffect } from "../config/iam-effects.js";
import { IamPolicy } from "../config/aws-arns.js";
import { getPartitionFromRegion } from "../config/aws-partition.js";
import { requireAssigneeCredentials } from "../config/aws-credentials.js";
import { AWS_REGION } from "../config/constants/aws.js";

/**
 * Actions granted to the operator principal in the compensating bucket policy.
 *
 * These are the same actions that Part 1 (identity-policy statement
 * `S3BucketDestructiveResourcePrefixScoped`) already grants unscoped at the
 * identity level. Repeating them in the resource-based policy with a
 * `aws:ResourceTag` condition does NOT re-restrict the identity-policy grant
 * (the identity policy still allows them unconditionally by resource prefix).
 * Instead, the bucket policy serves as a *declarative intent signal* — any
 * future admin-level SCP or resource-control policy (RCP) can use the bucket
 * policy's presence as a reliable indicator that this bucket is Assignee-
 * managed and the operator's destructive access is intentional.
 *
 * The 6 actions mirror the compensating-policy spec (story acceptance criteria G):
 *   s3:DeleteBucket          — CCAPI destroy path
 *   s3:DeleteBucketPolicy    — pre-delete cleanup (defense-in-depth)
 *   s3:DeleteObject          — pre-delete empty sweep
 *   s3:DeleteObjectVersion   — pre-delete versioned sweep
 *   s3:ListBucket            — enumerate objects before delete
 *   s3:ListBucketVersions    — enumerate versions before delete
 */
export const COMPENSATING_POLICY_ACTIONS: readonly string[] = [
  "s3:DeleteBucket",
  "s3:DeleteBucketPolicy",
  "s3:DeleteObject",
  "s3:DeleteObjectVersion",
  "s3:ListBucket",
  "s3:ListBucketVersions",
];

/** Tag key/value used to scope the compensating Allow in the bucket policy. */
export const MANAGED_BY_TAG_KEY = "managed-by" as const;
export const MANAGED_BY_TAG_VALUE = "assignee-ai" as const;

export interface CompensatingPolicyArgs {
  /** Bare S3 bucket name (not the full ARN). */
  bucketName: string;
  /** Full ARN of the operator principal (e.g. `arn:aws:iam::ACCOUNT:user/assignee-operator`). */
  operatorArn: string;
  /** AWS region used to resolve the correct partition for the resource ARN in the policy. */
  region: string;
  /**
   * Override the `managed-by` tag value (default: "assignee-ai").
   * Only needed for testing with non-production tag values.
   */
  managedByTag?: string;
}

export interface AttachResult {
  /** `true` when `PutBucketPolicy` succeeded. */
  attached: boolean;
  /** Human-readable reason when `attached` is `false`. */
  reason?: string;
}

/**
 * Builds the compensating bucket policy JSON object.
 *
 * The policy grants the operator ARN the 6 destructive actions on
 * `arn:<partition>:s3:::<bucketName>` (bucket-level) and
 * `arn:<partition>:s3:::<bucketName>/*` (object-level), conditional
 * on the bucket carrying `aws:ResourceTag/managed-by = assignee-ai`.
 *
 * Returns a plain object — caller is responsible for JSON.stringify.
 */
export function buildCompensatingBucketPolicy(
  args: CompensatingPolicyArgs,
): object {
  const partition = getPartitionFromRegion(args.region);
  const managedByValue = args.managedByTag ?? MANAGED_BY_TAG_VALUE;
  const bucketArn = `arn:${partition}:s3:::${args.bucketName}`;

  return {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Sid: "AssigneeOperatorDestructiveTagScoped",
        Effect: IamEffect.ALLOW,
        Principal: {
          AWS: args.operatorArn,
        },
        Action: [...COMPENSATING_POLICY_ACTIONS].sort(),
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: {
          StringEquals: {
            [`aws:ResourceTag/${MANAGED_BY_TAG_KEY}`]: managedByValue,
          },
        },
      },
    ],
  };
}

/**
 * Attaches the compensating bucket policy via `PutBucketPolicy`.
 *
 * On failure (network error, throttling, IAM gap), returns
 * `{ attached: false, reason: "<message>" }` — does NOT throw.
 * The caller is responsible for logging and deciding whether to
 * surface a user-visible warning.
 *
 * @param args       - Bucket name, operator ARN, region.
 * @param s3Client   - Optional pre-constructed S3Client (injectable for tests).
 *                     When omitted, a new client is created using operator
 *                     credentials from the environment.
 */
export async function attachCompensatingBucketPolicy(
  args: CompensatingPolicyArgs,
  s3Client?: S3Client,
): Promise<AttachResult> {
  const policy = buildCompensatingBucketPolicy(args);
  const client =
    s3Client ??
    new S3Client({
      region: args.region || AWS_REGION,
      credentials: requireAssigneeCredentials("operator"),
    });

  try {
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: args.bucketName,
        Policy: JSON.stringify(policy),
      }),
    );
    return { attached: true };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { attached: false, reason };
  }
}
