/**
 * Auditor role policy generator.
 * Security read-only: IAM simulate + read, SecurityHub read, GuardDuty read,
 * Inspector read, IAM Access Analyzer read.
 *
 * Split out of `iam-policies.ts` for SRP.
 */

import { IamEffect } from "../iam-effects.js";
import { IamPolicy, IamAction } from "../aws-arns.js";
import type { PolicyDocument } from "./types.js";

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
