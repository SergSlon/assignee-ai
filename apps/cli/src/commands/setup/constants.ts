/**
 * Setup-command constants — role definitions, managed tag, and Bedrock
 * invocation-logging identifiers. Exported so every sub-module in
 * ./setup/ can share a single source of truth without re-importing
 * @assignee/core symbol groups.
 */

import {
  operatorPolicy,
  operatorServicesAPolicy,
  operatorServicesBPolicy,
  readerPolicy,
  auditorPolicy,
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
  AssigneeTag,
  type PolicyDocument,
} from "@assignee/core";

/**
 * Maps role keys to their policy generators, user names, and env var prefixes.
 *
 * The operator surface is split across THREE managed policies:
 *   - `AssigneeOperatorPolicy` — core: Bedrock + CCAPI + tagging + XRay + SDK fallback
 *   - `AssigneeOperatorServicesAPolicy` — first byte-balanced half
 *   - `AssigneeOperatorServicesBPolicy` — second byte-balanced half
 *
 * The multi-policy split is required to fit inside AWS's 6144-byte
 * managed-policy size limit. All three attach to the same user — AWS
 * evaluates the union, strictly equivalent to a single-policy version.
 */
export const ROLES = [
  {
    key: "operator" as const,
    userName: IAM_USER_NAMES.operator,
    policies: [
      { name: IAM_POLICY_NAMES.operator, fn: operatorPolicy },
      { name: IAM_POLICY_NAMES.operatorServicesA, fn: operatorServicesAPolicy },
      { name: IAM_POLICY_NAMES.operatorServicesB, fn: operatorServicesBPolicy },
    ],
    envKeyId: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
    envSecretKey: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
    description: "CLI operator — Bedrock + CloudControl provisioning",
  },
  {
    key: "reader" as const,
    userName: IAM_USER_NAMES.reader,
    policies: [{ name: IAM_POLICY_NAMES.reader, fn: readerPolicy }],
    envKeyId: "ASSIGNEE_READER_ACCESS_KEY_ID",
    envSecretKey: "ASSIGNEE_READER_SECRET_ACCESS_KEY",
    description: "MCP reader — schema, pricing, billing (read-only)",
  },
  {
    key: "auditor" as const,
    userName: IAM_USER_NAMES.auditor,
    policies: [{ name: IAM_POLICY_NAMES.auditor, fn: auditorPolicy }],
    envKeyId: "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
    envSecretKey: "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
    description: "MCP auditor — IAM simulate, SecurityHub (read-only)",
  },
] as const;

export type Role = (typeof ROLES)[number];

/** Standard tag applied to all IAM resources managed by assignee.ai. */
export const MANAGED_TAG = { Key: AssigneeTag.KEY, Value: AssigneeTag.VALUE };

/** Bedrock invocation logging constants. */
export const BEDROCK_LOGGING_ROLE_NAME = "AssigneeAiBedrockLoggingRole";
export const BEDROCK_LOGGING_POLICY_NAME = "BedrockLoggingPolicy";
export const BEDROCK_LOG_GROUP_NAME = "/assignee-ai/bedrock-invocations";

export type { PolicyDocument };
