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
} from "./action-collector.js";

/**
 * IAM actions that the operator needs for role lifecycle management
 * (creation, trust/permission policy attachment, PassRole to AWS
 * services). These four actions form the classic priv-esc chain when
 * granted with Resource "*" — the operator could create a role with
 * `AdministratorAccess` and assume it.
 *
 * Story 50-5 B-3: emitted in their own statement scoped to the
 * `role/assignee-*` name prefix under the caller's partition + account
 * with an `iam:PassedToService` condition restricting PassRole to the
 * small set of AWS services Assignee actually hands roles to.
 *
 * The `action-collector` is taught to skip these four actions from
 * the unscoped service sweep so the scoped statement is the sole
 * grant path — IAM union semantics would otherwise let the unscoped
 * allow win and defeat the scoping.
 */
export const IAM_ROLE_MANAGEMENT_ACTIONS = new Set<string>([
  "iam:CreateRole",
  "iam:PassRole",
  "iam:AttachRolePolicy",
  "iam:PutRolePolicy",
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
        // Story 50-5 H-1: previously unscoped tag:TagResources /
        // tag:GetResources could re-tag any resource in the account
        // — including stripping managed-by on a resource owned by a
        // different principal. Now scoped to:
        //   (a) only mutate the assignee-owned tag key set, and
        //   (b) always stamp managed-by=assignee-ai on writes.
        // feedback_partition_aware_arn_matching note: the tag API
        // operates on ARNs across partitions; the condition uses the
        // partition-agnostic `aws:RequestTag` / `aws:TagKeys` keys so
        // no partition literal is needed here.
        Sid: "ResourceTagging",
        Effect: IamEffect.ALLOW,
        Action: [IamAction.TAG_TAG_RESOURCES, IamAction.TAG_GET_RESOURCES],
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
        // variable `${aws:PartitionId}` + `${aws:AccountId}` are
        // evaluated at policy-evaluation time). `iam:PassedToService`
        // restricts PassRole to the services Assignee actually
        // provisions roles for.
        Sid: "IamRoleManagementAssigneeScoped",
        Effect: IamEffect.ALLOW,
        Action: [...IAM_ROLE_MANAGEMENT_ACTIONS].sort(),
        Resource:
          "arn:${aws:PartitionId}:iam::${aws:AccountId}:role/assignee-*",
        Condition: {
          StringEquals: {
            "iam:PassedToService": [...ASSIGNEE_PASS_ROLE_SERVICES],
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
