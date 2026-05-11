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

import {
  S3Client,
  PutBucketPolicyCommand,
  GetBucketPolicyCommand,
} from "@aws-sdk/client-s3";
import { IamEffect } from "../config/iam-effects.js";
import { IamPolicy } from "../config/aws-arns.js";
import { getPartitionFromRegion } from "../config/aws-partition.js";
import { requireAssigneeCredentials } from "../config/aws-credentials.js";
import { AWS_REGION } from "../config/constants/aws.js";
import { log, LOG_ACTIONS } from "../utils/logger/index.js";

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

/**
 * Statement Sid for the compensating allow. Used by the merge logic in
 * `attachCompensatingBucketPolicy` to find + replace the same statement
 * idempotently (instead of appending duplicates) when an existing policy
 * already carries it.
 */
export const COMPENSATING_POLICY_SID =
  "AssigneeOperatorDestructiveTagScoped" as const;

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
 *
 * bug-s3-bucket-policy-region-fallback-edge-case: derive the effective
 * region by falling back to `AWS_REGION` when `args.region` is empty so
 * the partition we splice into the resource ARN matches the partition the
 * S3 client is talking to. Without this, a GovCloud caller passing
 * `region: ""` would build an `arn:aws:` policy ARN while the client
 * connects to a `us-gov-*` endpoint, producing a partition mismatch the
 * operator would not see until the policy attaches to the wrong scope.
 */
export function buildCompensatingBucketPolicy(
  args: CompensatingPolicyArgs,
): object {
  const effectiveRegion = args.region || AWS_REGION;
  const partition = getPartitionFromRegion(effectiveRegion);
  const managedByValue = args.managedByTag ?? MANAGED_BY_TAG_VALUE;
  const bucketArn = `arn:${partition}:s3:::${args.bucketName}`;

  return {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Sid: COMPENSATING_POLICY_SID,
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
 * Type-safe shape for a single bucket-policy Statement. We only need to
 * read the Sid for the merge logic; everything else is preserved by-value
 * so the rewritten policy keeps any caller-supplied keys (Condition,
 * NotAction, NotPrincipal, …) intact.
 */
interface PolicyStatement {
  Sid?: string;
  [k: string]: unknown;
}

interface PolicyDocument {
  Version?: string;
  Statement?: PolicyStatement[];
  [k: string]: unknown;
}

/**
 * Attaches the compensating bucket policy.
 *
 * **bug-s3-oac-bucket-policy-clobbering**: a plain `PutBucketPolicy`
 * REPLACES the entire bucket policy, which clobbers any prior statements
 * (most importantly the `cloudfront.amazonaws.com` OAC grant the
 * static-website compound's `AWS::S3::BucketPolicy` step attaches before
 * we run). Instead of blind PUT, the new flow is:
 *
 *   1. `GetBucketPolicy` on the bucket.
 *   2. NoSuchBucketPolicy → start from an empty statement list.
 *   3. Other GET errors (Throttle / AccessDenied / network) → log a
 *      warn and fall through to legacy PUT-only behaviour so non-OAC
 *      buckets stay compatible with operators that lack `s3:GetBucketPolicy`.
 *   4. Malformed JSON in the existing policy → return
 *      `{ attached: false, reason }` and do NOT PUT. Overwriting a
 *      malformed policy would also overwrite whatever the operator
 *      intended that policy to express.
 *   5. Merge by Sid: if an existing statement has the same Sid as the
 *      compensating statement (`AssigneeOperatorDestructiveTagScoped`),
 *      REPLACE it; otherwise APPEND the new statement to the existing
 *      list. Then PUT the merged document.
 *
 * On any unexpected error during PUT, returns
 * `{ attached: false, reason: "<message>" }` — does NOT throw. The
 * caller is responsible for logging and deciding whether to surface a
 * user-visible warning.
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
  // bug-s3-bucket-policy-region-fallback-edge-case: resolve the effective
  // region ONCE at function entry and reuse for both the policy ARN and
  // the client. Previously the policy ARN was built with `args.region`
  // (falling back to partition `aws` when empty) while the client used
  // `args.region || AWS_REGION` — silently mismatched on a GovCloud
  // caller that passed `region: ""`.
  const effectiveRegion = args.region || AWS_REGION;
  const newPolicy = buildCompensatingBucketPolicy({
    ...args,
    region: effectiveRegion,
  }) as PolicyDocument;
  const compensatingStatement = newPolicy.Statement?.[0];
  if (!compensatingStatement) {
    // Defensive — buildCompensatingBucketPolicy always returns one
    // statement, but the explicit guard makes the merge logic below
    // safe against any future refactor.
    return {
      attached: false,
      reason: "buildCompensatingBucketPolicy returned no statements",
    };
  }
  const client =
    s3Client ??
    new S3Client({
      region: effectiveRegion,
      credentials: requireAssigneeCredentials("operator"),
    });

  // ── Step 1 + 2 + 3: GET the existing bucket policy ─────────────────
  let existingStatements: PolicyStatement[] = [];
  try {
    const getResp = (await client.send(
      new GetBucketPolicyCommand({ Bucket: args.bucketName }),
    )) as { Policy?: string };
    const existingJson = getResp.Policy;
    if (existingJson) {
      // ── Step 4: malformed-JSON guard ──────────────────────────────
      let parsed: PolicyDocument;
      try {
        parsed = JSON.parse(existingJson) as PolicyDocument;
      } catch (parseErr) {
        return {
          attached: false,
          reason: `existing bucket policy is malformed JSON — refusing PutBucketPolicy to avoid overwriting operator-intended policy (${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          })`,
        };
      }
      // Coerce Statement to an array even when AWS returned a single-
      // object form (rare but legal — IAM/S3 accept both).
      const stmt = parsed.Statement;
      if (Array.isArray(stmt)) {
        existingStatements = stmt;
      } else if (stmt && typeof stmt === "object") {
        existingStatements = [stmt as PolicyStatement];
      }
    }
  } catch (err: unknown) {
    const name =
      err instanceof Error && (err as { name?: string }).name
        ? (err as { name?: string }).name!
        : "";
    const code =
      err instanceof Error && (err as { Code?: string }).Code
        ? (err as { Code?: string }).Code!
        : "";
    const message = err instanceof Error ? err.message : String(err);
    const isNoSuchPolicy =
      name === "NoSuchBucketPolicy" ||
      code === "NoSuchBucketPolicy" ||
      /NoSuchBucketPolicy/i.test(message);
    if (!isNoSuchPolicy) {
      // M-H-002 (PR #40): Non-NoSuch error from GET (e.g. throttling,
      // AccessDenied, network error) — return early rather than falling
      // through to a PUT-only legacy path. The legacy fallthrough was the
      // OAC clobber: it would PUT a policy containing ONLY the compensating
      // statement, silently destroying any existing OAC grant or other
      // operator-intended statements on the bucket.
      //
      // Early return here means we refuse to PUT when we cannot safely merge.
      // The caller decides whether to surface a user-visible warning.
      log({
        ts: new Date().toISOString(),
        runId: "compensating-bucket-policy",
        level: "warn",
        action: LOG_ACTIONS.S3_GET_BUCKET_POLICY_FAILED,
        extras: {
          compensatingPolicyGetFailed: true,
          bucket: args.bucketName,
          errorName: name || undefined,
          error: message,
        },
      });
      return {
        attached: false,
        reason: `GetBucketPolicy failed: ${message}`,
      };
    }
    // NoSuchBucketPolicy → existingStatements stays [] and we merge.
  }

  // ── Step 5: merge by Sid ───────────────────────────────────────────
  let mergedStatements: PolicyStatement[];
  const existingSidIndex = existingStatements.findIndex(
    (s) => s?.Sid === COMPENSATING_POLICY_SID,
  );
  if (existingSidIndex >= 0) {
    // Replace the stale compensating statement in place — preserves
    // the order of the operator-intended statements (e.g. OAC grant
    // first, compensating second) so the rewritten policy diffs
    // cleanly against the pre-PUT version.
    mergedStatements = [...existingStatements];
    mergedStatements[existingSidIndex] = compensatingStatement;
  } else {
    mergedStatements = [...existingStatements, compensatingStatement];
  }

  const mergedPolicy: PolicyDocument = {
    ...newPolicy,
    Statement: mergedStatements,
  };

  // ── PUT the merged policy ──────────────────────────────────────────
  try {
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: args.bucketName,
        Policy: JSON.stringify(mergedPolicy),
      }),
    );
    return { attached: true };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { attached: false, reason };
  }
}
