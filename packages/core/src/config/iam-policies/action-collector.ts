/**
 * Service-action collection + byte-balanced partition for the operator
 * policies. Implements `collectServiceActions()` and
 * `splitServiceActions()` used by `operatorPolicy()` and the A/B
 * services split.
 *
 * Split out of `iam-policies.ts` for SRP.
 */

import { SUPPORTED_TYPES_ARRAY } from "../resource-types.js";
import { getRequiredIamActions } from "../iam-actions.js";
import { collapseToWildcards } from "./wildcard-collapser.js";

/**
 * Security MEDIUM from .agents/reviews/security-expert-e2e-fixes.md #2,
 * re-scoped after review of unreviewed-p2-p3 + epic47-final.
 *
 * DeleteDBSnapshot + CopyDBSnapshot scoped via
 * `aws:ResourceTag/managed-by = assignee-ai`.
 * CreateDBSnapshot scoped via `aws:RequestTag/managed-by = assignee-ai`
 * (evaluates the tag being applied AT CREATE TIME). Forces every
 * operator-initiated create to tag the snapshot — closes the
 * cross-account-exfiltration path flagged by blind-hunter S2.
 */
export const RESOURCE_TAG_SCOPED_SNAPSHOT_ACTIONS = new Set([
  "rds:DeleteDBSnapshot",
  "rds:CopyDBSnapshot",
]);
export const REQUEST_TAG_SCOPED_SNAPSHOT_ACTIONS = new Set([
  "rds:CreateDBSnapshot",
]);
export const TAG_SCOPED_RDS_SNAPSHOT_ACTIONS = new Set([
  ...RESOURCE_TAG_SCOPED_SNAPSHOT_ACTIONS,
  ...REQUEST_TAG_SCOPED_SNAPSHOT_ACTIONS,
]);

/**
 * IAM role-lifecycle actions that must be excluded from the unscoped
 * service sweep so the dedicated `IamRoleManagementAssigneeScoped`
 * statement in operatorPolicy() is the sole grant path.
 *
 * Story 50-5 B-3: leaving these in operatorServicesA/B would allow
 * IAM union semantics to bypass the `role/assignee-*` scoping. See
 * operator.ts `IAM_ROLE_MANAGEMENT_ACTIONS` — kept in lock-step.
 *
 * W13-S2 (M-α-16): `iam:DeleteRole`, `iam:DetachRolePolicy`,
 * `iam:DeleteRolePolicy` added — destructive actions that were
 * previously landing in `ServiceSpecificActionsA/B` with
 * `Resource: "*"`. A leaked operator credential could delete or
 * strip policies from ANY IAM role in the account. Now scoped to
 * `role/assignee-*` in the `IamRoleManagementAssigneeScoped`
 * statement (without the `iam:PassedToService` condition, which only
 * applies to PassRole, not to delete/detach operations).
 */
export const PRIV_ESC_SCOPED_IAM_ACTIONS = new Set<string>([
  "iam:CreateRole",
  "iam:PassRole",
  "iam:AttachRolePolicy",
  "iam:PutRolePolicy",
  "iam:DeleteRole",
  "iam:DetachRolePolicy",
  "iam:DeleteRolePolicy",
]);

/**
 * IAM instance-profile lifecycle actions used by the SSH-bundle compound
 * (`ssh-iam.ts`). Must be excluded from the unscoped service sweep and
 * emitted instead via a dedicated `IamInstanceProfileAssigneeScoped`
 * statement scoped to `instance-profile/assignee-*` in operator.ts.
 *
 * Story i (SSH-IAM compound BLOCKER #1): leaving these in
 * `ServiceSpecificActionsA/B` with `Resource: "*"` would let a leaked
 * operator credential create / delete / mutate ANY instance profile in
 * the account. The scoped statement restricts to the
 * `assignee-ssh-<runId-suffix>` naming prefix.
 */
export const IAM_INSTANCE_PROFILE_SCOPED_ACTIONS = new Set<string>([
  "iam:CreateInstanceProfile",
  "iam:DeleteInstanceProfile",
  "iam:GetInstanceProfile",
  "iam:AddRoleToInstanceProfile",
  "iam:RemoveRoleFromInstanceProfile",
  "iam:TagInstanceProfile",
]);

/**
 * SecretsManager actions that must be excluded from the unscoped
 * service sweep and emitted instead via a tag-scoped statement in
 * operatorPolicy(). Follows the same pattern as
 * TAG_SCOPED_RDS_SNAPSHOT_ACTIONS.
 *
 * W13-S2 (M-α-17): `secretsmanager:GetSecretValue` was landing in
 * `ServiceSpecificActionsA/B` with `Resource: "*"` — a leaked
 * operator credential could read ANY secret in the account. Now
 * scoped to secrets tagged `managed-by=assignee-ai` via the
 * `SecretsManagerGetValueTagScoped` statement using
 * `aws:ResourceTag/managed-by` (evaluated at read-time against the
 * secret's existing tags — NOT `aws:RequestTag` which applies to
 * creates).
 */
export const TAG_SCOPED_SECRETS_ACTIONS = new Set<string>([
  "secretsmanager:GetSecretValue",
]);

/**
 * Destructive service actions that must be excluded from the unscoped
 * service sweep (ServiceSpecificActionsA/B) and emitted instead via a
 * dedicated `ServiceDestructiveResourceTagScoped` statement in
 * operatorPolicy() with `aws:ResourceTag/managed-by = assignee-ai`.
 *
 * SEC-011 (full-audit-2026-04-29): these actions had `Resource: "*"` with
 * no Condition in operatorServicesA/B — a leaked operator credential could
 * delete/terminate any resource in the account, regardless of whether it
 * was provisioned by Assignee. Scoping to `aws:ResourceTag/managed-by =
 * assignee-ai` limits the blast radius to Assignee-managed resources only.
 *
 * aws:ResourceTag is evaluated at request time against the target resource's
 * existing tags — the correct condition key for mutating/destructive
 * operations on already-existing resources (as opposed to aws:RequestTag,
 * which applies to the tags being SET on a create call).
 *
 * Keep in sync with `ServiceDestructiveResourceTagScoped` in operator.ts.
 * Action granularity rationale:
 *   lambda:DeleteFunction  → deletes a Lambda function; taggable in Lambda API
 *   ec2:TerminateInstances → terminates EC2 instances; tags on instance
 *   ecs:DeleteCluster      → deletes ECS cluster; tags on cluster
 *   sqs:DeleteQueue        → deletes SQS queue; tags on queue
 *   sns:DeleteTopic        → deletes SNS topic; tags on topic
 *   rds:DeleteDBInstance   → deletes RDS instance; tags on DBInstance
 *
 * NOTE: s3:DeleteBucket and s3:DeleteBucketPolicy are intentionally ABSENT
 * from this set. AWS does NOT auto-populate `aws:ResourceTag` into the
 * IAM evaluation context for S3 bucket-level destructive operations, so a
 * tag-scoped Allow for those actions always evaluates to implicitDeny
 * (MissingContextValues: ["aws:ResourceTag/managed-by", ...]). They live
 * instead in `S3_BUCKET_DESTRUCTIVE_ACTIONS` / the dedicated
 * `S3BucketDestructiveResourcePrefixScoped` statement with no Condition.
 * See docs/explanation/security-model.md §S3 bucket-level IAM limitation.
 */
export const DESTRUCTIVE_SERVICE_ACTIONS = new Set<string>([
  "lambda:DeleteFunction",
  "ec2:TerminateInstances",
  "ecs:DeleteCluster",
  "sqs:DeleteQueue",
  "sns:DeleteTopic",
  "rds:DeleteDBInstance",
  // Pre-delete empty sweep actions: the destroy-service.ts s3BucketStrategy
  // calls DeleteObjects (requires s3:DeleteObject) and DeleteObjects with
  // VersionId (requires s3:DeleteObjectVersion) to empty the bucket before
  // CloudControl DeleteBucket runs. Without tag-scoping these, a leaked
  // operator credential could delete objects from ANY S3 bucket in the
  // account. Scoped via aws:ResourceTag/managed-by=assignee-ai so the
  // operator can only empty assignee-managed buckets.
  // NOTE: object-level S3 operations (DeleteObject / DeleteObjectVersion)
  // DO get aws:ResourceTag auto-populated by AWS (different code path from
  // bucket-level operations). These correctly remain tag-scoped.
  "s3:DeleteObject",
  "s3:DeleteObjectVersion",
]);

/**
 * S3 BUCKET-LEVEL destructive actions that CANNOT be tag-scoped via
 * `aws:ResourceTag` at the IAM identity-policy level.
 *
 * AWS LIMITATION (confirmed 2026-05-07):
 * AWS does NOT auto-populate `aws:ResourceTag` into the IAM request
 * evaluation context for `s3:DeleteBucket` and `s3:DeleteBucketPolicy`.
 * When the Allow statement has `Condition: { StringEquals: { "aws:ResourceTag/
 * managed-by": "assignee-ai" } }`, the StringEquals comparison receives
 * `<missing>` for the tag value and returns false — the Allow never
 * matches — implicit deny — generic "no identity-based policy allows this
 * action" error even though the bucket carries the correct tag.
 *
 * Empirical evidence:
 *   1. `aws iam simulate-principal-policy ... --action-names s3:DeleteBucket
 *      --resource-arns arn:aws:s3:::genai-demo-logs` (no explicit context)
 *      → EvalDecision: implicitDeny, MissingContextValues includes
 *      "aws:ResourceTag/managed-by".
 *   2. Same call WITH --context-entries for the tag → EvalDecision: allowed.
 *   3. Live test: s3:DeleteBucket with the tag-scoped policy → AccessDenied.
 *   4. Temp inline policy with s3:DeleteBucket + Resource:"*" + no Condition
 *      → DeleteBucket succeeded immediately.
 *
 * Contrast: Lambda / EC2 / ECS / SQS / SNS / RDS all correctly propagate
 * resource tags into the IAM context — those services remain tag-scoped in
 * DESTRUCTIVE_SERVICE_ACTIONS. Object-level S3 operations (DeleteObject /
 * DeleteObjectVersion) also propagate correctly (different AWS code path).
 *
 * Security tradeoff: `s3:DeleteBucket` and `s3:DeleteBucketPolicy` are
 * now scoped only by `Resource: "arn:aws:s3:::*"` (no tag Condition).
 * The operator can technically issue s3:DeleteBucket against any S3 bucket
 * in the account. Mitigations:
 *   - Every other action (Lambda / EC2 / etc.) remains tag-scoped.
 *   - Bucket-policy attached at `assignee apply` time (see Part 2 of the
 *     bug story) restores per-bucket scoping for assignee-managed buckets.
 *   - Non-assignee buckets are protected by their own bucket policies
 *     (unless they explicitly grant the operator, which only assignee-managed
 *     buckets do via the compensating control).
 *
 * References:
 *   - AWS re:Post: https://repost.aws/questions/QUyMnHQq6oTdyx76CMRhZ4yA
 *   - docs/explanation/security-model.md §S3 bucket-level IAM limitation
 *   - Bug story: bug-s3-destructive-tag-condition-aws-limitation.md
 *
 * Keep in sync with `S3BucketDestructiveResourcePrefixScoped` in operator.ts.
 */
export const S3_BUCKET_DESTRUCTIVE_ACTIONS = new Set<string>([
  "s3:DeleteBucket",
  "s3:DeleteBucketPolicy",
]);

export function collectServiceActions(): {
  ccapiActions: string[];
  serviceActions: string[];
} {
  const allActions = new Set<string>();
  for (const resourceType of SUPPORTED_TYPES_ARRAY) {
    for (const action of getRequiredIamActions(resourceType)) {
      allActions.add(action);
    }
  }

  const ccapiActions: string[] = [];
  const serviceActionsRaw: string[] = [];
  for (const action of allActions) {
    if (action.startsWith("cloudcontrol:")) {
      ccapiActions.push(action);
    } else if (TAG_SCOPED_RDS_SNAPSHOT_ACTIONS.has(action)) {
      // Skip — emitted separately in operatorPolicy() with a
      // ResourceTag-scoped Condition (security MEDIUM from the
      // e2e expert review).
      continue;
    } else if (PRIV_ESC_SCOPED_IAM_ACTIONS.has(action)) {
      // Story 50-5 B-3: emitted separately in operatorPolicy() via
      // the IamRoleManagementAssigneeScoped statement with
      // `role/assignee-*` resource scope + iam:PassedToService
      // allowlist. Leaving them in the unscoped sweep would let
      // IAM union semantics bypass the scope.
      // W13-S2 (M-α-16): also covers DeleteRole/DetachRolePolicy/
      // DeleteRolePolicy — emitted in the same scoped statement
      // (without PassedToService Condition, which is PassRole-only).
      continue;
    } else if (TAG_SCOPED_SECRETS_ACTIONS.has(action)) {
      // W13-S2 (M-α-17): emitted separately in operatorPolicy()
      // via SecretsManagerGetValueTagScoped with
      // aws:ResourceTag/managed-by = assignee-ai. Leaving it in
      // the unscoped sweep would allow reading any secret.
      continue;
    } else if (IAM_INSTANCE_PROFILE_SCOPED_ACTIONS.has(action)) {
      // Story i (SSH-IAM compound BLOCKER #1): emitted separately
      // in operatorPolicy() via IamInstanceProfileAssigneeScoped
      // with Resource scoped to `instance-profile/assignee-*`. The
      // unscoped sweep would let a leaked operator credential mutate
      // any instance profile in the account.
      continue;
    } else if (DESTRUCTIVE_SERVICE_ACTIONS.has(action)) {
      // SEC-011 (full-audit-2026-04-29): emitted separately in
      // operatorPolicy() via ServiceDestructiveResourceTagScoped
      // with aws:ResourceTag/managed-by = assignee-ai. Leaving
      // destructive actions in the unscoped sweep would allow
      // deleting/terminating any resource in the account.
      continue;
    } else if (S3_BUCKET_DESTRUCTIVE_ACTIONS.has(action)) {
      // Bug S3-001 (2026-05-07): AWS does NOT auto-populate
      // aws:ResourceTag for s3:DeleteBucket / s3:DeleteBucketPolicy
      // (bucket-level destructive ops). These actions are emitted
      // separately in operatorPolicy() via the dedicated
      // S3BucketDestructiveResourcePrefixScoped statement with
      // Resource: "arn:aws:s3:::*" and NO Condition. Leaving them
      // in the unscoped sweep would be harmless (same effective
      // permission) but confusing — keeping them out maintains the
      // invariant that ALL potentially-harmful actions are excluded
      // from ServiceSpecificActionsA/B.
      continue;
    } else {
      serviceActionsRaw.push(action);
    }
  }
  ccapiActions.sort();
  // Wave 19: collapse safe read-only wildcards (Describe* / Get* / List*)
  // before emitting so the generated policy fits inside AWS's 6144-byte
  // managed-policy size limit. iam-actions.ts stays explicit; only the
  // emitted document is compacted.
  const serviceActions = collapseToWildcards(serviceActionsRaw);
  return { ccapiActions, serviceActions };
}

/**
 * Partitions the fully-collected, sorted service-specific action list
 * into two byte-balanced halves (`a` and `b`) so each half can be
 * emitted as its own managed policy and still fit inside the AWS
 * 6144-byte limit.
 *
 * Algorithm (deterministic, stable, byte-balanced):
 *   1. Compute the total serialized byte count of the action array.
 *   2. Walk the sorted list accumulating byte cost (quoted + comma).
 *   3. Cut at the first index where the running total has crossed
 *      half of the grand total — putting the rest in `b`.
 *
 * Why cumulative bytes and not `splice(length / 2)`? Service actions
 * vary in length; a count-based midpoint would silently grow lopsided
 * as long-named services dominate one half. The byte-based cut keeps
 * both halves within a couple percent of each other.
 */
export function splitServiceActions(actions: readonly string[]): {
  a: string[];
  b: string[];
} {
  if (actions.length < 2) {
    return { a: [...actions], b: [] };
  }
  // Approximate JSON serialization cost per action: the action string
  // itself + two quotes + a comma. Off by a constant but the ratio is
  // preserved.
  const byteCost = (s: string): number => s.length + 3;
  const total = actions.reduce((sum, a) => sum + byteCost(a), 0);
  const halfTarget = total / 2;
  let running = 0;
  let cut = 0;
  for (let i = 0; i < actions.length; i++) {
    running += byteCost(actions[i]!);
    if (running >= halfTarget) {
      cut = i + 1;
      break;
    }
  }
  // Defensive: always leave at least one action in each half.
  if (cut === 0) cut = 1;
  if (cut >= actions.length) cut = actions.length - 1;
  return {
    a: actions.slice(0, cut),
    b: actions.slice(cut),
  };
}
