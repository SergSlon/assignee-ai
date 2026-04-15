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
        Sid: "ResourceTagging",
        Effect: IamEffect.ALLOW,
        Action: [IamAction.TAG_TAG_RESOURCES, IamAction.TAG_GET_RESOURCES],
        Resource: "*",
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
