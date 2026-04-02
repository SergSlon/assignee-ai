/**
 * IAM policy document generators for the 3-user credential model.
 * Single source of truth — derives permissions from SUPPORTED_TYPES_ARRAY and getRequiredIamActions().
 *
 * @see Story 18.8 — IAM Security Overhaul
 */

import { SUPPORTED_TYPES_ARRAY } from "./resource-types.js";
import { getRequiredIamActions } from "./iam-actions.js";
import { IamEffect, type IamEffectType } from "./iam-effects.js";
import { BEDROCK_MODEL_ARN_WILDCARD } from "./aws-arns.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PolicyStatement {
  Sid: string;
  Effect: IamEffectType;
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocument {
  Version: "2012-10-17";
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
    "lambda:CreateEventSourceMapping",
    "lambda:GetEventSourceMapping",
    "lambda:DeleteEventSourceMapping",
    "sns:Subscribe",
    "sns:Unsubscribe",
  ];

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BedrockInvoke",
        Effect: IamEffect.ALLOW,
        Action: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
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
        Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
        Resource: "*",
      },
      {
        Sid: "ResourceTagging",
        Effect: IamEffect.ALLOW,
        Action: ["tag:TagResources", "tag:GetResources"],
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
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "CloudFormationSchemaRead",
        Effect: IamEffect.ALLOW,
        Action: ["cloudformation:DescribeType", "cloudformation:ListTypes"],
        Resource: "*",
      },
      {
        Sid: "ResourceDiscoveryRead",
        Effect: IamEffect.ALLOW,
        Action: [
          "ssm:GetParameter",
          "ec2:DescribeInstances",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeKeyPairs",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeImages",
          "rds:DescribeDBEngineVersions",
          "rds:DescribeOrderableDBInstanceOptions",
        ],
        Resource: "*",
      },
      {
        Sid: "PricingRead",
        Effect: IamEffect.ALLOW,
        Action: [
          "pricing:GetProducts",
          "pricing:DescribeServices",
          "pricing:GetAttributeValues",
        ],
        Resource: "*",
      },
      {
        Sid: "CostExplorerRead",
        Effect: IamEffect.ALLOW,
        Action: ["ce:GetCostAndUsage", "ce:GetCostForecast"],
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
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "IAMSimulateAndRead",
        Effect: IamEffect.ALLOW,
        Action: [
          "iam:SimulateCustomPolicy",
          "iam:SimulatePrincipalPolicy",
          "iam:GetUser",
          "iam:GetRole",
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
          "iam:GetUserPolicy",
          "iam:GetRolePolicy",
          "iam:ListUsers",
          "iam:ListRoles",
          "iam:ListPolicies",
          "iam:ListUserPolicies",
          "iam:ListRolePolicies",
          "iam:ListAttachedUserPolicies",
          "iam:ListAttachedRolePolicies",
        ],
        Resource: "*",
      },
      {
        Sid: "SecurityHubRead",
        Effect: IamEffect.ALLOW,
        Action: [
          "securityhub:GetFindings",
          "securityhub:GetInsights",
          "securityhub:GetEnabledStandards",
          "securityhub:ListFindings",
          "securityhub:ListEnabledProductsForImport",
          "securityhub:DescribeHub",
          "securityhub:DescribeStandards",
          "securityhub:DescribeStandardsControls",
          "securityhub:BatchGetFindings",
        ],
        Resource: "*",
      },
      {
        Sid: "GuardDutyRead",
        Effect: IamEffect.ALLOW,
        Action: [
          "guardduty:GetDetector",
          "guardduty:GetFindings",
          "guardduty:ListDetectors",
          "guardduty:ListFindings",
        ],
        Resource: "*",
      },
      {
        Sid: "InspectorRead",
        Effect: IamEffect.ALLOW,
        Action: [
          "inspector2:ListFindings",
          "inspector2:GetFindingsReportStatus",
          "inspector2:ListCoverage",
        ],
        Resource: "*",
      },
      {
        Sid: "IAMAccessAnalyzerRead",
        Effect: IamEffect.ALLOW,
        Action: [
          "access-analyzer:GetAnalyzer",
          "access-analyzer:ListAnalyzers",
          "access-analyzer:ListFindings",
          "access-analyzer:GetFinding",
        ],
        Resource: "*",
      },
    ],
  };
}
