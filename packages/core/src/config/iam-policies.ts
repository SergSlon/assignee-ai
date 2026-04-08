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
 * Wave 19 Bug #6 follow-up: AWS IAM managed policies have a hard 6144-byte
 * size limit. As assignee.ai grew to 25 supported resource types, the
 * generated operator policy now exceeds that limit if we list every action
 * literally — even though `iam-actions.ts` (the source of truth) keeps each
 * action explicit for documentation and security review.
 *
 * This collapser replaces N+ actions sharing a `service:Verb` prefix with a
 * single `service:Verb*` wildcard when the wildcard is **safe** — defined as:
 *
 *   - The wildcard set is a known read-only / metadata operation prefix
 *     (Describe, Get, List) so the wildcard does not silently grant more
 *     write capabilities than the granular set already grants.
 *   - The collapsed set replaces 3+ actions (otherwise the collapse saves
 *     fewer bytes than the additional review burden of a wildcard).
 *
 * The output is byte-stable: same input → same output, no nondeterministic
 * ordering. Sorting + dedup happens after the collapse so the final
 * policy diff is review-friendly.
 *
 * If the collapser ever needs to handle a write-side prefix (Create*,
 * Delete*, Modify*, Put*) that's a security review threshold and should
 * be added explicitly to SAFE_WILDCARD_PREFIXES below, NOT inferred from
 * the action shape.
 */
const SAFE_WILDCARD_PREFIXES: ReadonlyArray<string> = [
  "Describe",
  "Get",
  "List",
];

function collapseToWildcards(actions: readonly string[]): string[] {
  // Group actions by `service:Verb` prefix where `Verb` is one of the
  // safe-wildcard prefixes. Anything that doesn't match any safe prefix
  // is preserved literally.
  const byPrefix = new Map<string, string[]>(); // "service:Verb" → matching actions
  const literal: string[] = [];

  for (const action of actions) {
    const colonIdx = action.indexOf(":");
    if (colonIdx === -1) {
      literal.push(action);
      continue;
    }
    const service = action.slice(0, colonIdx);
    const verb = action.slice(colonIdx + 1);
    const matchedPrefix = SAFE_WILDCARD_PREFIXES.find((p) =>
      verb.startsWith(p),
    );
    if (!matchedPrefix) {
      literal.push(action);
      continue;
    }
    const groupKey = `${service}:${matchedPrefix}`;
    if (!byPrefix.has(groupKey)) byPrefix.set(groupKey, []);
    byPrefix.get(groupKey)!.push(action);
  }

  const collapsed: string[] = [];
  for (const [groupKey, members] of byPrefix) {
    // Only collapse when 3+ actions share the prefix — otherwise the
    // wildcard is more permissive than the granular set without saving
    // meaningful bytes.
    if (members.length >= 3) {
      collapsed.push(`${groupKey}*`);
    } else {
      // Sub-threshold — keep them literal
      literal.push(...members);
    }
  }

  return [...new Set([...literal, ...collapsed])].sort();
}

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
  const serviceActionsRaw: string[] = [];
  for (const action of allActions) {
    if (action.startsWith("cloudcontrol:")) {
      ccapiActions.push(action);
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
