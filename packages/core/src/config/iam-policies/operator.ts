/**
 * Operator role policy generators: core + services-A + services-B.
 *
 * Split out of `iam-policies.ts` for SRP.
 *
 * Historical context: A8 (2026-04-08) first split the operator policy
 * into core + services to fit inside AWS's 6144-byte managed-policy
 * limit. (f) 2026-04-09 split the services half into A + B after
 * A10-A14 pushed it over the 700-byte canary floor.
 *
 * All three of `AssigneeOperatorPolicy` (core), `...ServicesAPolicy`,
 * and `...ServicesBPolicy` attach to the same `assignee-operator` IAM
 * user. IAM evaluates the union — strictly equivalent to the
 * pre-split single-policy version.
 *
 * Story 50-5 (Epic 50 L5 BLOCKER-3 + HIGH-1):
 *   - `iam:CreateRole`, `iam:PassRole`, `iam:AttachRolePolicy`, and
 *     `iam:PutRolePolicy` used to live in the unscoped service sweep
 *     with `Resource: "*"`. An operator credential leak could pivot
 *     via these actions into a full account takeover. They now live
 *     in a dedicated `IamRoleManagementAssigneeScoped` statement
 *     scoped to `role/assignee-*` under the caller's partition +
 *     account, with `iam:PassedToService` restricted to the
 *     services Assignee actually provisions roles for.
 *   - `tag:TagResources` / `tag:GetResources` were previously
 *     unscoped. The tagging sweep is now conditioned on the
 *     operator ONLY adding/mutating `managed-by`,
 *     `assignee-run-id`, `assignee-environment`, `Name` tag keys
 *     AND specifically setting `managed-by=assignee-ai`. Operators
 *     can no longer strip the managed-by tag off unrelated
 *     resources or overwrite it to bypass the
 *     "TOCTOU tag missing" destroy guard.
 */

import { SUPPORTED_TYPES_ARRAY } from "../resource-types.js";
import { IamEffect } from "../iam-effects.js";
import {
  IamPolicy,
  IamAction,
  BEDROCK_MODEL_ARN_WILDCARD,
} from "../aws-arns.js";
import type { PolicyDocument } from "./types.js";
import {
  collectServiceActions,
  splitServiceActions,
  RESOURCE_TAG_SCOPED_SNAPSHOT_ACTIONS,
  REQUEST_TAG_SCOPED_SNAPSHOT_ACTIONS,
  TAG_SCOPED_SECRETS_ACTIONS,
  DESTRUCTIVE_SERVICE_ACTIONS,
  S3_BUCKET_DESTRUCTIVE_ACTIONS,
  IAM_INSTANCE_PROFILE_SCOPED_ACTIONS,
} from "./action-collector.js";

/**
 * IAM actions that the operator needs for role lifecycle management
 * (creation, trust/permission policy attachment, PassRole to AWS
 * services, and teardown). These actions form the classic priv-esc
 * chain when granted with Resource "*" — the operator could create a
 * role with `AdministratorAccess` and assume it, or strip policies
 * from any role in the account.
 *
 * Story 50-5 B-3: original 4 actions (Create/Pass/Attach/Put) emitted
 * in their own statement scoped to `role/assignee-*` with an
 * `iam:PassedToService` condition restricting PassRole to the services
 * Assignee actually hands roles to.
 *
 * W13-S2 (M-α-16): 3 additional destructive actions (Delete/Detach/
 * DeletePolicy) added. These must NOT carry the `iam:PassedToService`
 * condition — AWS does not support PassedToService on delete/detach
 * operations and the policy would be rejected. They are emitted in a
 * separate `IamRoleDestructiveAssigneeScoped` statement with only the
 * `role/assignee-*` resource scope.
 *
 * The `action-collector` is taught to skip ALL seven actions from the
 * unscoped service sweep so the scoped statements are the sole grant
 * paths.
 */
export const IAM_ROLE_MANAGEMENT_ACTIONS = new Set<string>([
  "iam:CreateRole",
  "iam:PassRole",
  "iam:AttachRolePolicy",
  "iam:PutRolePolicy",
]);

/**
 * Destructive IAM role-lifecycle actions that are scoped to
 * `role/assignee-*` but do NOT use the `iam:PassedToService`
 * condition (which is only valid for PassRole, not for
 * delete/detach operations).
 *
 * W13-S2 (M-α-16): These were previously landing in
 * `ServiceSpecificActionsA/B` with `Resource: "*"`.
 */
export const IAM_ROLE_DESTRUCTIVE_ACTIONS = new Set<string>([
  "iam:DeleteRole",
  "iam:DetachRolePolicy",
  "iam:DeleteRolePolicy",
]);

/**
 * Services Assignee provisions execution / assume roles for. Scopes
 * `iam:PassedToService` so a leaked operator credential cannot pass
 * the assignee-* role to an unrelated trust principal and use that
 * to pivot account-wide.
 *
 * Keep aligned with the resource types Assignee actually supports
 * (see SUPPORTED_TYPES_ARRAY):
 *   - lambda.amazonaws.com        → AWS::Lambda::Function
 *   - ecs-tasks.amazonaws.com     → AWS::ECS::Cluster (task roles)
 *   - events.amazonaws.com        → AWS::Events::Rule (targets need a role)
 *   - rds.amazonaws.com           → AWS::RDS::DBInstance (monitoring + enhanced logs)
 *   - ec2.amazonaws.com           → AWS::EC2::Instance (instance profile)
 *   - scheduler.amazonaws.com     → EventBridge Scheduler (roadmap; listed in spec)
 *   - states.amazonaws.com        → Step Functions (roadmap; listed in spec)
 */
export const ASSIGNEE_PASS_ROLE_SERVICES: readonly string[] = [
  "lambda.amazonaws.com",
  "ecs-tasks.amazonaws.com",
  "events.amazonaws.com",
  "rds.amazonaws.com",
  "ec2.amazonaws.com",
  "scheduler.amazonaws.com",
  "states.amazonaws.com",
];

/**
 * Tag keys the operator is allowed to set / mutate via the
 * ResourceGroupsTagging sweep. H-1: previously any tag key on any
 * resource was fair game; now the operator can only touch the
 * assignee-owned tag set and must always set `managed-by=assignee-ai`.
 */
export const ASSIGNEE_MANAGED_TAG_KEYS: readonly string[] = [
  "managed-by",
  "assignee-run-id",
  "assignee-environment",
  "Name",
];

/**
 * Generates the operator-core policy document.
 * Highest privilege: Bedrock invoke, CloudControl CRUD (scoped to
 * SUPPORTED_TYPES_ARRAY), XRay tracing, resource tagging, SDK fallback
 * actions.
 *
 * The bulky service-specific actions live in SEPARATE managed policies
 * (`operatorServicesAPolicy()` + `operatorServicesBPolicy()`) so the
 * combined surface fits inside the AWS 6144-byte-per-managed-policy
 * limit. All three attach to the same `assignee-operator` IAM user.
 *
 * @param modelArn - Optional Bedrock model ARN. Defaults to wildcard foundation model.
 */
export function operatorPolicy(
  modelArn: string = BEDROCK_MODEL_ARN_WILDCARD,
): PolicyDocument {
  const { ccapiActions } = collectServiceActions();

  // SDK fallback actions for types that bypass CloudControl.
  // A6  (2026-04-08): Lambda EventSourceMapping migrated to CCAPI.
  // A10 (2026-04-09): SNS::Subscription promoted to first-class.
  // Only SSH key-pair companion operations remain unscoped — EC2::KeyPair's
  // CCAPI schema lacks the readable KeyMaterial field.
  const sdkFallbackActions = [
    IamAction.EC2_CREATE_KEY_PAIR,
    IamAction.EC2_DELETE_KEY_PAIR,
    IamAction.EC2_DESCRIBE_KEY_PAIRS,
  ];

  return {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Sid: "BedrockInvoke",
        Effect: IamEffect.ALLOW,
        Action: [IamAction.BEDROCK_INVOKE, IamAction.BEDROCK_INVOKE_STREAM],
        Resource: modelArn,
      },
      {
        Sid: "CloudControlScopedToSupportedTypes",
        Effect: IamEffect.ALLOW,
        Action: ccapiActions,
        Resource: "*",
        Condition: {
          StringEquals: {
            "cloudcontrol:TypeName": [...SUPPORTED_TYPES_ARRAY],
          },
        },
      },
      {
        Sid: "SdkFallbackActions",
        Effect: IamEffect.ALLOW,
        Action: sdkFallbackActions,
        Resource: "*",
      },
      {
        Sid: "XRayTracing",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.XRAY_PUT_TRACE_SEGMENTS,
          IamAction.XRAY_PUT_TELEMETRY,
        ],
        Resource: "*",
      },
      {
        // F6 (2026-05-24): `admin list --total-cost` / `infra destroy
        // --all` use CloudWatch's `BucketSizeBytes` metric to convert
        // per-GB-month S3 storage rates into real `$X.XX/mo` totals
        // instead of the rate-hint fallback. `GetMetricStatistics`
        // does NOT support resource-level scoping (it scopes by metric
        // namespace via Condition keys), so the Resource is `*` and
        // the Condition restricts to `AWS/S3` — operator credential
        // leak can't pivot to read arbitrary application metrics
        // (custom namespaces, AWS/EC2, AWS/Lambda…) that might
        // disclose sensitive operational signal.
        //
        // Without this statement the storage-enricher's CloudWatch
        // calls return AccessDenied, the silent-swallow path leaves
        // the storage map empty, and the F6 promotion never fires
        // (display reverts to the pre-fix rate hint).
        //
        // @see _backlog/wizard-ux-audit-2026-05-22.md F6
        // @see apps/cli/src/services/storage-enricher.ts (consumer)
        Sid: "CloudWatchStorageMetricsRead",
        Effect: IamEffect.ALLOW,
        Action: ["cloudwatch:GetMetricStatistics"],
        Resource: "*",
        Condition: {
          StringEquals: {
            "cloudwatch:namespace": "AWS/S3",
          },
        },
      },
      {
        // SEC-009 (full-audit-2026-04-29): tag:GetResources is a READ
        // operation — aws:RequestTag does not apply to reads (it
        // evaluates the tags being SET in the request, which is absent
        // for a list/read call). Applying aws:RequestTag to GetResources
        // would either silently deny ALL reads (condition evaluates to
        // missing-key → deny) or be ignored. The correct condition for a
        // read is aws:TagKeys (limits which tag keys the caller can
        // filter by) — that's sufficient to prevent an operator from
        // listing resources via arbitrary tag keys outside the
        // assignee-owned set.
        //
        // feedback_partition_aware_arn_matching note: the tag API
        // operates on ARNs across partitions; aws:TagKeys is
        // partition-agnostic so no partition literal is needed.
        Sid: "ResourceTaggingRead",
        Effect: IamEffect.ALLOW,
        Action: [IamAction.TAG_GET_RESOURCES],
        Resource: "*",
        Condition: {
          "ForAllValues:StringEquals": {
            "aws:TagKeys": [...ASSIGNEE_MANAGED_TAG_KEYS],
          },
        },
      },
      {
        // Story 50-5 H-1: tag:TagResources previously granted Resource "*"
        // unconditionally — an operator credential leak could strip the
        // managed-by tag off any resource in the account (breaking the
        // "destroy TOCTOU tag missing" refusal) or overwrite managed-by
        // to hijack another principal's tag-scoped IAM grants.
        //
        // SEC-009 (full-audit-2026-04-29): split from ResourceTagging so
        // the write-only conditions (aws:RequestTag + aws:TagKeys) apply
        // only to tag:TagResources. aws:RequestTag is valid for writes
        // (evaluates the tags being SET in this call); the TagKeys
        // allowlist prevents adding arbitrary key-value pairs.
        //
        // feedback_partition_aware_arn_matching: condition keys are
        // partition-agnostic — no ARN literal needed.
        Sid: "ResourceTaggingWrite",
        Effect: IamEffect.ALLOW,
        Action: [IamAction.TAG_TAG_RESOURCES],
        Resource: "*",
        Condition: {
          "ForAllValues:StringEquals": {
            "aws:TagKeys": [...ASSIGNEE_MANAGED_TAG_KEYS],
          },
          StringEquals: {
            "aws:RequestTag/managed-by": "assignee-ai",
          },
        },
      },
      {
        // Story 50-5 B-3: priv-esc prevention for role lifecycle
        // management. Resource scoped to the `assignee-*` role name
        // prefix under the caller's partition + account (IAM policy
        // `*` is the IAM-spec partition wildcard (Access Analyzer rejects
        // `aws*` for IAM Resource ARNs; the only accepted partition
        // wildcards are `*`, `aws`, `aws-cn`, `aws-us-gov`).
        // `${aws:AccountId}` IS
        // evaluated at policy-evaluation time). `iam:PassedToService`
        // restricts PassRole to the services Assignee actually
        // provisions roles for.
        //
        // NOTE: only the 4 create/pass/attach/put actions land here —
        // the PassedToService Condition is ONLY valid for PassRole and
        // the full group of non-destructive role management actions.
        // AWS rejects a policy statement that applies PassedToService
        // to Delete/Detach operations. Those 3 actions live in the
        // sibling IamRoleDestructiveAssigneeScoped statement below.
        Sid: "IamRoleManagementAssigneeScoped",
        Effect: IamEffect.ALLOW,
        Action: [...IAM_ROLE_MANAGEMENT_ACTIONS].sort(),
        Resource: "arn:*:iam::${aws:AccountId}:role/assignee-*",
        Condition: {
          StringEquals: {
            "iam:PassedToService": [...ASSIGNEE_PASS_ROLE_SERVICES],
          },
        },
      },
      {
        // W13-S2 (M-α-16): Destructive IAM role-lifecycle actions
        // scoped to `role/assignee-*`. These were previously landing
        // in ServiceSpecificActionsA/B with Resource "*" — a leaked
        // operator credential could delete or strip policies from ANY
        // IAM role in the account.
        //
        // Intentionally no iam:PassedToService Condition here — that
        // condition is only valid for iam:PassRole (a "passing to
        // service" context). AWS rejects policies that apply it to
        // DeleteRole/DetachRolePolicy/DeleteRolePolicy.
        //
        // SEC-010 (full-audit-2026-04-29): add aws:ResourceTag/managed-by
        // = assignee-ai as an additional condition for cross-tenant safety.
        // Without this, ANY `role/assignee-*` in the account could be
        // deleted even if it was not created by Assignee (e.g. a
        // manually-created role whose name starts with "assignee-" but
        // belongs to a different team). aws:ResourceTag is evaluated at
        // authorization time against the role's existing tags — the
        // correct key for destructive operations on existing resources
        // (NOT aws:RequestTag, which applies to the tags being SET in
        // the API call and is irrelevant for delete/detach operations).
        Sid: "IamRoleDestructiveAssigneeScoped",
        Effect: IamEffect.ALLOW,
        Action: [...IAM_ROLE_DESTRUCTIVE_ACTIONS].sort(),
        Resource: "arn:*:iam::${aws:AccountId}:role/assignee-*",
        Condition: {
          StringEquals: {
            "aws:ResourceTag/managed-by": "assignee-ai",
          },
        },
      },
      {
        // M-H-001 (PR #40): CloudFront invalidation actions scoped to
        // distributions tagged `managed-by=assignee-ai`. Previously these
        // flowed through collectServiceActions() into ServiceSpecificActionsA/B
        // with Resource "*" — a leaked operator credential could invalidate
        // ANY CloudFront distribution in the account.
        //
        // Resource uses the partition wildcard `*` (same as the IAM role
        // scoped statements above) so the policy is valid in GovCloud +
        // China. `${aws:AccountId}` expands at evaluation time.
        //
        // aws:ResourceTag is evaluated at authorization time against the
        // distribution's existing tags — the correct condition key for
        // operations on already-existing resources (NOT aws:RequestTag).
        Sid: "CloudFrontInvalidationTagScoped",
        Effect: IamEffect.ALLOW,
        Action: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
        Resource: "arn:*:cloudfront::${aws:AccountId}:distribution/*",
        Condition: {
          StringEquals: {
            "aws:ResourceTag/managed-by": "assignee-ai",
          },
        },
      },
      {
        // Story i (SSH-IAM compound BLOCKER #1): the SSH-bundle
        // pre-provision hook (`ssh-iam.ts`) calls 4 instance-profile
        // verbs (Create / Delete / AddRole / RemoveRole) plus
        // GetInstanceProfile (idempotency check) and TagInstanceProfile
        // (so the auto-created profile is discoverable by any future
        // IAM-aware destroy sweep — per
        // feedback_assignee_infra_safety_allowlist +
        // feedback_iam_role_rgta_gap. Story 50-3 removed the bulk
        // destroy CLI surface; tags remain the durable mechanism).
        //
        // Resource scope mirrors the IAM-role scoped statements above:
        // `arn:*:iam::${aws:AccountId}:instance-profile/assignee-*` —
        // partition wildcard `*` is the only IAM-spec partition wildcard
        // accepted by Access Analyzer; `${aws:AccountId}` expands at
        // policy-evaluation time. The naming-prefix `assignee-` aligns
        // with the `assignee-ssh-<runId-suffix>` convention enforced by
        // `ensureSshIamProfile()` in ssh-iam.ts.
        //
        // No iam:PassedToService Condition: that key applies to PassRole
        // only; AWS rejects it on instance-profile lifecycle operations.
        Sid: "IamInstanceProfileAssigneeScoped",
        Effect: IamEffect.ALLOW,
        Action: [...IAM_INSTANCE_PROFILE_SCOPED_ACTIONS].sort(),
        Resource: "arn:*:iam::${aws:AccountId}:instance-profile/assignee-*",
      },
      {
        // W13-S2 (M-α-17): secretsmanager:GetSecretValue was
        // previously in ServiceSpecificActionsA/B with Resource "*"
        // — a leaked operator credential could read ANY secret in the
        // account. Now scoped to secrets tagged managed-by=assignee-ai
        // via aws:ResourceTag (evaluated at read-time against the
        // secret's existing tags — NOT aws:RequestTag, which applies
        // to creates and would always evaluate against an untagged
        // resource at read time).
        Sid: "SecretsManagerGetValueTagScoped",
        Effect: IamEffect.ALLOW,
        Action: [...TAG_SCOPED_SECRETS_ACTIONS].sort(),
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:ResourceTag/managed-by": "assignee-ai",
          },
        },
      },
      {
        // Security MEDIUM (security-expert-e2e-fixes.md #2). RDS
        // DeleteDBSnapshot + CopyDBSnapshot evaluated against an
        // existing snapshot — scope via `aws:ResourceTag/managed-by
        // = assignee-ai`. RDS propagates the parent DBInstance's
        // tag to manual snapshots so legitimate flows pass.
        Sid: "RdsSnapshotMutateTagScoped",
        Effect: IamEffect.ALLOW,
        Action: [...RESOURCE_TAG_SCOPED_SNAPSHOT_ACTIONS].sort(),
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:ResourceTag/managed-by": "assignee-ai",
          },
        },
      },
      {
        // Security follow-up (epic47-final blind-hunter S2). Scope
        // CreateDBSnapshot via `aws:RequestTag/managed-by = assignee-ai`
        // — evaluates the tag being APPLIED at create time.
        Sid: "RdsSnapshotCreateRequestTagScoped",
        Effect: IamEffect.ALLOW,
        Action: [...REQUEST_TAG_SCOPED_SNAPSHOT_ACTIONS].sort(),
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:RequestTag/managed-by": "assignee-ai",
          },
        },
      },
      {
        // SEC-011 (full-audit-2026-04-29): destructive service actions
        // (lambda:DeleteFunction, ec2:TerminateInstances, etc.) were
        // previously in ServiceSpecificActionsA/B with `Resource: "*"`
        // and no Condition — a leaked operator credential could delete
        // or terminate ANY resource of these types in the account,
        // regardless of whether Assignee provisioned it.
        //
        // All actions here are moved out of the unscoped service sweep
        // (see DESTRUCTIVE_SERVICE_ACTIONS in action-collector.ts) and
        // granted only when the target resource carries the
        // `managed-by=assignee-ai` tag.
        //
        // aws:ResourceTag is the correct condition key for destructive
        // operations: it evaluates against the resource's EXISTING tags
        // at authorization time. aws:RequestTag would evaluate the tags
        // being SET in the API call — inappropriate here because delete
        // and terminate operations do not accept tag parameters.
        //
        // Resource: "*" is intentional — the ARN format differs across
        // services (Lambda functions, EC2 instances, ECS clusters, SQS
        // queues, SNS topics, RDS instances). The aws:ResourceTag
        // condition provides the effective scope.
        //
        // NOTE: s3:DeleteBucket and s3:DeleteBucketPolicy are intentionally
        // ABSENT from this statement — see S3BucketDestructiveResourcePrefixScoped
        // below for the AWS limitation that requires a separate approach.
        // s3:DeleteObject and s3:DeleteObjectVersion ARE included here because
        // object-level S3 operations correctly receive aws:ResourceTag context.
        Sid: "ServiceDestructiveResourceTagScoped",
        Effect: IamEffect.ALLOW,
        Action: [...DESTRUCTIVE_SERVICE_ACTIONS].sort(),
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:ResourceTag/managed-by": "assignee-ai",
          },
        },
      },
      {
        // Bug S3-001 (2026-05-07) — AWS S3 BUCKET-LEVEL IAM LIMITATION.
        //
        // AWS does NOT auto-populate `aws:ResourceTag` into the IAM
        // request-evaluation context for `s3:DeleteBucket` and
        // `s3:DeleteBucketPolicy`. This is an AWS-side limitation confirmed
        // via `aws iam simulate-principal-policy` (returns implicitDeny with
        // MissingContextValues: ["aws:ResourceTag/managed-by"]) and via a
        // live DeleteBucket call that succeeded only after a temporary inline
        // policy with Resource:"*" and NO Condition was applied.
        //
        // The same aws:ResourceTag pattern works correctly for all other
        // supported service types (Lambda / EC2 / ECS / SQS / SNS / RDS)
        // and for object-level S3 operations (DeleteObject / DeleteObjectVersion)
        // — those remain in ServiceDestructiveResourceTagScoped above.
        //
        // SECURITY TRADEOFF: without a Condition, the operator can technically
        // issue s3:DeleteBucket against any S3 bucket in the account.
        // Mitigations:
        //   1. Resource: "arn:aws:s3:::*" narrows to S3 bucket ARNs only
        //      (no account-ID slot in S3 ARNs — this is the narrowest
        //      resource specification possible for bucket-level operations).
        //   2. Every non-S3 destructive action remains tag-scoped (blast
        //      radius of a leaked operator credential is limited to S3).
        //   3. Bucket policy attached at `assignee infra apply` time (compensating
        //      control) re-establishes per-bucket tagging enforcement at the
        //      resource-policy boundary (resource-based policies DO evaluate
        //      bucket tags correctly for bucket-level operations).
        //   4. Non-assignee buckets are protected by their own bucket policies'
        //      default-deny unless those policies explicitly grant this operator
        //      (which only assignee-managed buckets do via the compensating
        //      control attached at create time).
        //
        // References:
        //   AWS re:Post: https://repost.aws/questions/QUyMnHQq6oTdyx76CMRhZ4yA
        //   Full analysis: docs/explanation/security-model.md
        //                  §S3 bucket-level IAM limitation
        //   Bug story: bug-s3-destructive-tag-condition-aws-limitation.md
        //
        // NO Condition is intentional — adding aws:ResourceTag here
        // causes the exact same implicitDeny failure this statement exists
        // to work around.
        Sid: "S3BucketDestructiveResourcePrefixScoped",
        Effect: IamEffect.ALLOW,
        Action: [...S3_BUCKET_DESTRUCTIVE_ACTIONS].sort(),
        Resource: "arn:aws:s3:::*",
      },
    ],
  };
}

/**
 * Generates the first half of the operator-services policy document.
 * See module-level comment for split rationale.
 */
export function operatorServicesAPolicy(): PolicyDocument {
  const { serviceActions } = collectServiceActions();
  const { a } = splitServiceActions(serviceActions);
  return {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Sid: "ServiceSpecificActionsA",
        Effect: IamEffect.ALLOW,
        Action: a,
        Resource: "*",
      },
    ],
  };
}

/**
 * Generates the second half of the operator-services policy document.
 * Both A + B are attached to the same `assignee-operator` IAM user —
 * IAM unions them.
 */
export function operatorServicesBPolicy(): PolicyDocument {
  const { serviceActions } = collectServiceActions();
  const { b } = splitServiceActions(serviceActions);
  return {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Sid: "ServiceSpecificActionsB",
        Effect: IamEffect.ALLOW,
        Action: b,
        Resource: "*",
      },
    ],
  };
}
