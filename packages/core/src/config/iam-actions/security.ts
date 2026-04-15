/**
 * IAM actions for security / identity / KMS / SecretsManager resource types.
 *
 * Split out of `iam-actions.ts` for SRP.
 */

import { RESOURCE_TYPES } from "../resource-types.js";

export const SECURITY_ACTIONS: Record<string, string[]> = {
  [RESOURCE_TYPES.IAM_ROLE]: [
    "iam:CreateRole",
    "iam:DeleteRole",
    "iam:GetRole",
    "iam:UpdateRole",
    "iam:AttachRolePolicy",
    "iam:DetachRolePolicy",
    "iam:PutRolePolicy",
    "iam:DeleteRolePolicy",
    "iam:TagRole",
    "iam:PassRole",
    // Required by list-resources/destroy-service. AWS Resource Groups
    // Tagging API does NOT return IAM::Role so we fall back to
    // iam:ListRoles + iam:ListRoleTags filtered by managed-by.
    "iam:ListRoles",
    "iam:ListRoleTags",
    // Required by CCAPI DeleteResource(AWS::IAM::Role) to enumerate
    // and detach policies before deleting the role itself.
    "iam:ListRolePolicies",
    "iam:ListAttachedRolePolicies",
    "iam:GetRolePolicy",
    // Wave 19 Bug #8: preflight verifies ManagedPolicyArns via iam:GetPolicy
    // before CCAPI sees them — closes the LLM-hallucinated-ARN gap.
    "iam:GetPolicy",
  ],
  // A11 (2026-04-09): AWS::KMS::Key.
  [RESOURCE_TYPES.KMS_KEY]: [
    "kms:CreateKey",
    "kms:ScheduleKeyDeletion",
    "kms:DescribeKey",
    "kms:EnableKey",
    "kms:DisableKey",
    "kms:EnableKeyRotation",
    "kms:DisableKeyRotation",
    "kms:GetKeyRotationStatus",
    "kms:GetKeyPolicy",
    "kms:PutKeyPolicy",
    "kms:UpdateKeyDescription",
    "kms:TagResource",
    "kms:UntagResource",
    "kms:ListResourceTags",
    "kms:ListKeys",
    // A12 follow-up: data-key operations needed by the Events::Connection
    // CCAPI create handler so the auto-generated Secret gets envelope
    // encrypted. Generally useful for any envelope-encryption flow.
    "kms:Encrypt",
    "kms:Decrypt",
    "kms:GenerateDataKey",
  ],
  [RESOURCE_TYPES.SECRETSMANAGER_SECRET]: [
    "secretsmanager:CreateSecret",
    "secretsmanager:DeleteSecret",
    "secretsmanager:DescribeSecret",
    "secretsmanager:UpdateSecret",
    "secretsmanager:PutSecretValue",
    "secretsmanager:GetSecretValue",
    "secretsmanager:TagResource",
    // CCAPI SecretsManager create handler calls GetRandomPassword
    // internally when the user doesn't pass a SecretString.
    "secretsmanager:GetRandomPassword",
  ],
};
