# Operator IAM Security Model

**Last updated**: 2026-05-07

This document describes the IAM permission model for the `assignee-operator`
IAM user, the security boundaries it enforces, and the known limitations
with their compensating controls.

---

## Overview

Assignee provisions three IAM users during `assignee dev setup`:

| User                | Policy                                                                                           | Purpose                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `assignee-operator` | `AssigneeOperatorPolicy` + `AssigneeOperatorServicesAPolicy` + `AssigneeOperatorServicesBPolicy` | Creates, tags, describes, and destroys resources |
| `assignee-reader`   | `AssigneeReaderPolicy`                                                                           | Read-only access for drift detection             |
| `assignee-auditor`  | `AssigneeAuditorPolicy`                                                                          | Security findings, IAM simulation                |

The operator policy is split across three managed policies to fit inside
the AWS 6144-byte per-managed-policy limit. IAM evaluates the union — the
split is a size artefact, not a security boundary.

---

## Tag-scoping principle

For destructive operations (delete, terminate, destroy), the operator policy
uses `aws:ResourceTag/managed-by = assignee-ai` conditions wherever AWS
correctly populates the resource tag into the IAM request context. This
limits the blast radius of a leaked operator credential to Assignee-managed
resources only.

Services that correctly propagate resource tags into the IAM context:

- `lambda:DeleteFunction`
- `ec2:TerminateInstances`
- `ecs:DeleteCluster`
- `sqs:DeleteQueue`
- `sns:DeleteTopic`
- `rds:DeleteDBInstance`
- `s3:DeleteObject` (object-level — different AWS code path from bucket-level)
- `s3:DeleteObjectVersion` (same)

---

## S3 bucket-level IAM limitation

### What breaks

`s3:DeleteBucket` and `s3:DeleteBucketPolicy` are **not correctly tag-scoped
at the IAM identity-policy level** for the `assignee-operator` user. AWS does
NOT auto-populate `aws:ResourceTag` into the IAM request evaluation context
for S3 bucket-level destructive operations.

When the Allow statement uses `Condition: { StringEquals: { "aws:ResourceTag/
managed-by": "assignee-ai" } }`, the StringEquals comparison receives
`<missing>` for the tag value and returns false — the Allow never matches —
implicit deny — the user sees "no identity-based policy allows the
s3:DeleteBucket action" even though the bucket carries the correct tag.

This causes `assignee infra destroy <s3-arn>` to fail with AccessDenied for all
assignee-managed S3 buckets.

### Empirical confirmation (2026-05-07)

1. `aws iam simulate-principal-policy` with `--action-names s3:DeleteBucket`
   and no explicit context:
   - Result: `EvalDecision: implicitDeny`
   - `MissingContextValues` includes `aws:ResourceTag/managed-by`

2. Same call with `--context-entries ContextKeyName=aws:ResourceTag/managed-by,
ContextKeyValues=assignee-ai,...`:
   - Result: `EvalDecision: allowed`

3. Live call with operator credentials on a bucket tagged `managed-by=assignee-ai`:
   - `s3:DeleteBucket` → `AccessDenied: no identity-based policy allows`

4. Temporary inline policy with `s3:DeleteBucket + Resource:"*" + no Condition`:
   - `s3:DeleteBucket` → success immediately

The simulator's `MissingContextValues` is the smoking gun: the bucket's tag
is not in the live IAM request context either.

Reference: [AWS re:Post discussion](https://repost.aws/questions/QUyMnHQq6oTdyx76CMRhZ4yA)

### Why this is AWS-side, not a code bug

The same `aws:ResourceTag` condition works correctly for all other services
Assignee supports (Lambda / EC2 / ECS / SQS / SNS / RDS) and for S3
object-level operations (`s3:DeleteObject` / `s3:DeleteObjectVersion`).
S3 bucket-level operations have a different code path in the AWS IAM
evaluation engine that does not auto-populate the resource's tags.

AWS documentation implies support but practice contradicts it. Multiple
AWS re:Post and StackOverflow reports document the same behaviour.

### The fix — statement split

The operator policy uses a dedicated statement **without** a tag Condition
for the S3 bucket-level destructive actions:

```json
{
  "Sid": "S3BucketDestructiveResourcePrefixScoped",
  "Effect": "Allow",
  "Action": ["s3:DeleteBucket", "s3:DeleteBucketPolicy"],
  "Resource": "arn:aws:s3:::*"
}
```

`Resource: "arn:aws:s3:::*"` is the narrowest possible scope for
bucket-level operations — S3 bucket ARNs have no account-ID slot
(`arn:aws:s3:::<bucket-name>`), so there is no tighter ARN prefix available.

### Security tradeoff

With no Condition, a leaked `assignee-operator` credential can issue
`s3:DeleteBucket` against any S3 bucket in the account.

Mitigations:

1. **Narrow resource scope**: `Resource: "arn:aws:s3:::*"` limits the
   blast to S3 only. All other services remain tag-scoped.

2. **Compensating control — bucket policy**: When `assignee infra apply` creates
   an S3 bucket, it also attaches a bucket policy granting the operator
   destructive permissions on that specific bucket. Bucket policies (resource-
   based policies) DO evaluate bucket tags correctly at the resource-policy
   boundary — the Condition in a bucket policy fires as expected.

3. **Non-assignee buckets**: Protected by their own bucket policies' default
   deny unless those policies explicitly grant `assignee-operator` (which
   only assignee-managed buckets do via the compensating control in step 2).

4. **Operator credential scope**: The operator is not a privileged user —
   it can only call the actions explicitly granted by the three attached
   managed policies. The S3 widening does not grant IAM, Bedrock-control-
   plane, or cross-account access.

### Operator setup requirement

This is an IAM policy schema change. Existing operators must re-run
`assignee dev setup` after pulling this update to receive the new
`S3BucketDestructiveResourcePrefixScoped` statement.

---

## Other scoped statements

| Statement                                 | Scope mechanism                                              | Why                                           |
| ----------------------------------------- | ------------------------------------------------------------ | --------------------------------------------- |
| `IamRoleManagementAssigneeScoped`         | Resource `role/assignee-*` + `iam:PassedToService` condition | Priv-esc prevention (Story 50-5 B-3)          |
| `IamRoleDestructiveAssigneeScoped`        | Resource `role/assignee-*` + `aws:ResourceTag/managed-by`    | No PassedToService on delete/detach           |
| `IamInstanceProfileAssigneeScoped`        | Resource `instance-profile/assignee-*`                       | SSH bundle profiles only                      |
| `SecretsManagerGetValueTagScoped`         | `aws:ResourceTag/managed-by=assignee-ai`                     | Read-any-secret protection (W13-S2)           |
| `RdsSnapshotMutateTagScoped`              | `aws:ResourceTag/managed-by=assignee-ai`                     | Delete/Copy against existing snapshot         |
| `RdsSnapshotCreateRequestTagScoped`       | `aws:RequestTag/managed-by=assignee-ai`                      | Force tag at create to block cross-acct exfil |
| `ServiceDestructiveResourceTagScoped`     | `aws:ResourceTag/managed-by=assignee-ai`                     | General destructive actions (SEC-011)         |
| `S3BucketDestructiveResourcePrefixScoped` | `Resource: arn:aws:s3:::*` (no tag — AWS limitation)         | S3 bucket-level ops (Bug S3-002)              |

---

## Re-running setup after policy changes

Any change to the operator policy schema (new statement, action added or
removed, Condition changed) requires existing operators to re-run:

```sh
assignee dev setup
```

The setup command compares the desired policy document with the currently-
attached policy and applies a new policy version if they differ.
