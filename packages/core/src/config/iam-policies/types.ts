/**
 * Shared types + identity constants for the 3-user IAM credential model.
 * Split out of `iam-policies.ts` for SRP.
 */

import { IamPolicy } from "../aws-arns.js";
import { type IamEffectType } from "../iam-effects.js";

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
  // A8 (2026-04-08): the operator role was split across two managed
  // policies — core + services — because the combined surface exceeded
  // the AWS 6144-byte managed-policy size limit at 28+ resource types.
  //
  // (f) 2026-04-09 A/B split: the services half outgrew the 700-byte
  // canary floor as well (A10-A14 landed SNS::Subscription, KMS::Key,
  // Events::Connection, Events::ApiDestination, and CloudFront
  // Distribution), so it is now split once more into Services-A +
  // Services-B. All three policies (core + A + B) attach to the same
  // `assignee-operator` IAM user. The A/B split is deterministic and
  // byte-balanced: service actions are sorted and partitioned at the
  // index that keeps the two halves within 2% of each other by
  // cumulative byte count.
  //
  // Multi-policy attach is explicitly AWS-supported (up to 10 managed
  // policies per IAM user) and is strictly preferred over a wildcard
  // collapser that would over-grant Create*/Delete*/Update* for entire
  // AWS services.
  operatorServicesA: "AssigneeOperatorServicesAPolicy",
  operatorServicesB: "AssigneeOperatorServicesBPolicy",
  reader: "AssigneeReaderPolicy",
  auditor: "AssigneeAuditorPolicy",
} as const;
