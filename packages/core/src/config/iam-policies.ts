/**
 * IAM policy document generators for the 3-user credential model.
 * Single source of truth — derives permissions from SUPPORTED_TYPES_ARRAY and getRequiredIamActions().
 *
 * @see Story 18.8 — IAM Security Overhaul
 */

import { SUPPORTED_TYPES_ARRAY } from "./resource-types.js";
import { getRequiredIamActions } from "./iam-actions.js";
import { IamEffect, type IamEffectType } from "./iam-effects.js";
import {
  IamPolicy,
  IamAction,
  BEDROCK_MODEL_ARN_WILDCARD,
} from "./aws-arns.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PolicyStatement {
  Sid: string;
  Effect: IamEffectType;
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocument {
  Version: typeof IamPolicy.VERSION;
  Statement: PolicyStatement[];
}

// ── Constants ────────────────────────────────────────────────────────────────

export const IAM_USER_NAMES = {
  operator: "assignee-operator",
  reader: "assignee-reader",
  auditor: "assignee-auditor",
} as const;

export const IAM_POLICY_NAMES = {
  operator: "AssigneeOperatorPolicy",
  reader: "AssigneeReaderPolicy",
  auditor: "AssigneeAuditorPolicy",
} as const;

// ── Policy Generators ────────────────────────────────────────────────────────

/**
 * Generates the operator policy document.
 * Highest privilege: Bedrock invoke, CloudControl CRUD (scoped to SUPPORTED_TYPES_ARRAY),
 * service-specific actions from IAM_ACTION_MAP, XRay tracing, resource tagging.
 *
 * @param modelArn - Optional Bedrock model ARN. Defaults to wildcard foundation model.
 */
export function operatorPolicy(
  modelArn: string = BEDROCK_MODEL_ARN_WILDCARD,
): PolicyDocument {
  // Aggregate all service-specific actions across all supported types
  const allActions = new Set<string>();
  for (const resourceType of SUPPORTED_TYPES_ARRAY) {
    for (const action of getRequiredIamActions(resourceType)) {
      allActions.add(action);
    }
  }

  // Separate CloudControl actions from service-specific actions
  const ccapiActions: string[] = [];
  const serviceActions: string[] = [];
  for (const action of allActions) {
    if (action.startsWith("cloudcontrol:")) {
      ccapiActions.push(action);
    } else {
      serviceActions.push(action);
    }
  }
  ccapiActions.sort();
  serviceActions.sort();

  // SDK fallback actions for types that bypass CloudControl
  const sdkFallbackActions = [
    IamAction.LAMBDA_CREATE_ESM,
    IamAction.LAMBDA_GET_ESM,
    IamAction.LAMBDA_DELETE_ESM,
    IamAction.SNS_SUBSCRIBE,
    IamAction.SNS_UNSUBSCRIBE,
    // SSH key pair auto-create flow (Epic 41 — SSH intent bundle)
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
        Sid: "ServiceSpecificActions",
        Effect: IamEffect.ALLOW,
        Action: serviceActions,
        Resource: "*",
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
    ],
  };
}

/**
 * Generates the reader policy document.
 * Read-only: CloudFormation schema read, Pricing API read, Cost Explorer read.
 */
export function readerPolicy(): PolicyDocument {
  return {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Sid: "CloudFormationSchemaRead",
        Effect: IamEffect.ALLOW,
        Action: [IamAction.CFN_DESCRIBE_TYPE, IamAction.CFN_LIST_TYPES],
        Resource: "*",
      },
      {
        Sid: "ResourceDiscoveryRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.SSM_GET_PARAMETER,
          IamAction.EC2_DESCRIBE_INSTANCES,
          IamAction.EC2_DESCRIBE_SUBNETS,
          IamAction.EC2_DESCRIBE_SECURITY_GROUPS,
          IamAction.EC2_DESCRIBE_KEY_PAIRS,
          IamAction.EC2_DESCRIBE_INSTANCE_TYPES,
          IamAction.EC2_DESCRIBE_IMAGES,
          IamAction.RDS_DESCRIBE_DB_ENGINE_VERSIONS,
          IamAction.RDS_DESCRIBE_ORDERABLE_INSTANCES,
        ],
        Resource: "*",
      },
      {
        Sid: "PricingRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.PRICING_GET_PRODUCTS,
          IamAction.PRICING_DESCRIBE_SERVICES,
          IamAction.PRICING_GET_ATTRIBUTE_VALUES,
        ],
        Resource: "*",
      },
      {
        Sid: "CostExplorerRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.CE_GET_COST_AND_USAGE,
          IamAction.CE_GET_COST_FORECAST,
        ],
        Resource: "*",
      },
    ],
  };
}

/**
 * Generates the auditor policy document.
 * Security read-only: IAM simulate + read, SecurityHub read, GuardDuty read,
 * Inspector read, IAM Access Analyzer read.
 */
export function auditorPolicy(): PolicyDocument {
  return {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Sid: "IAMSimulateAndRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.IAM_SIMULATE_CUSTOM_POLICY,
          IamAction.IAM_SIMULATE_PRINCIPAL_POLICY,
          IamAction.IAM_GET_USER,
          IamAction.IAM_GET_ROLE,
          IamAction.IAM_GET_POLICY,
          IamAction.IAM_GET_POLICY_VERSION,
          IamAction.IAM_GET_USER_POLICY,
          IamAction.IAM_GET_ROLE_POLICY,
          IamAction.IAM_LIST_USERS,
          IamAction.IAM_LIST_ROLES,
          IamAction.IAM_LIST_POLICIES,
          IamAction.IAM_LIST_USER_POLICIES,
          IamAction.IAM_LIST_ROLE_POLICIES,
          IamAction.IAM_LIST_ATTACHED_USER_POLICIES,
          IamAction.IAM_LIST_ATTACHED_ROLE_POLICIES,
        ],
        Resource: "*",
      },
      {
        Sid: "SecurityHubRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.SECURITYHUB_GET_FINDINGS,
          IamAction.SECURITYHUB_GET_INSIGHTS,
          IamAction.SECURITYHUB_GET_ENABLED_STANDARDS,
          IamAction.SECURITYHUB_LIST_FINDINGS,
          IamAction.SECURITYHUB_LIST_ENABLED_PRODUCTS,
          IamAction.SECURITYHUB_DESCRIBE_HUB,
          IamAction.SECURITYHUB_DESCRIBE_STANDARDS,
          IamAction.SECURITYHUB_DESCRIBE_STANDARDS_CONTROLS,
          IamAction.SECURITYHUB_BATCH_GET_FINDINGS,
        ],
        Resource: "*",
      },
      {
        Sid: "GuardDutyRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.GUARDDUTY_GET_DETECTOR,
          IamAction.GUARDDUTY_GET_FINDINGS,
          IamAction.GUARDDUTY_LIST_DETECTORS,
          IamAction.GUARDDUTY_LIST_FINDINGS,
        ],
        Resource: "*",
      },
      {
        Sid: "InspectorRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.INSPECTOR_LIST_FINDINGS,
          IamAction.INSPECTOR_GET_FINDINGS_REPORT_STATUS,
          IamAction.INSPECTOR_LIST_COVERAGE,
        ],
        Resource: "*",
      },
      {
        Sid: "IAMAccessAnalyzerRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.ACCESS_ANALYZER_GET_ANALYZER,
          IamAction.ACCESS_ANALYZER_LIST_ANALYZERS,
          IamAction.ACCESS_ANALYZER_LIST_FINDINGS,
          IamAction.ACCESS_ANALYZER_GET_FINDING,
        ],
        Resource: "*",
      },
    ],
  };
}
