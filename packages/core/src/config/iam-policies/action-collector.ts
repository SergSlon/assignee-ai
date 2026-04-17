/**
 * Service-action collection + byte-balanced partition for the operator
 * policies. Implements `collectServiceActions()` and
 * `splitServiceActions()` used by `operatorPolicy()` and the A/B
 * services split.
 *
 * Split out of `iam-policies.ts` for SRP.
 */

import { SUPPORTED_TYPES_ARRAY } from "../resource-types.js";
import { getRequiredIamActions } from "../iam-actions.js";
import { collapseToWildcards } from "./wildcard-collapser.js";

/**
 * Security MEDIUM from .agents/reviews/security-expert-e2e-fixes.md #2,
 * re-scoped after review of unreviewed-p2-p3 + epic47-final.
 *
 * DeleteDBSnapshot + CopyDBSnapshot scoped via
 * `aws:ResourceTag/managed-by = assignee-ai`.
 * CreateDBSnapshot scoped via `aws:RequestTag/managed-by = assignee-ai`
 * (evaluates the tag being applied AT CREATE TIME). Forces every
 * operator-initiated create to tag the snapshot — closes the
 * cross-account-exfiltration path flagged by blind-hunter S2.
 */
export const RESOURCE_TAG_SCOPED_SNAPSHOT_ACTIONS = new Set([
  "rds:DeleteDBSnapshot",
  "rds:CopyDBSnapshot",
]);
export const REQUEST_TAG_SCOPED_SNAPSHOT_ACTIONS = new Set([
  "rds:CreateDBSnapshot",
]);
export const TAG_SCOPED_RDS_SNAPSHOT_ACTIONS = new Set([
  ...RESOURCE_TAG_SCOPED_SNAPSHOT_ACTIONS,
  ...REQUEST_TAG_SCOPED_SNAPSHOT_ACTIONS,
]);

/**
 * IAM role-lifecycle actions that must be excluded from the unscoped
 * service sweep so the dedicated `IamRoleManagementAssigneeScoped`
 * statement in operatorPolicy() is the sole grant path.
 *
 * Story 50-5 B-3: leaving these in operatorServicesA/B would allow
 * IAM union semantics to bypass the `role/assignee-*` scoping. See
 * operator.ts `IAM_ROLE_MANAGEMENT_ACTIONS` — kept in lock-step.
 */
export const PRIV_ESC_SCOPED_IAM_ACTIONS = new Set<string>([
  "iam:CreateRole",
  "iam:PassRole",
  "iam:AttachRolePolicy",
  "iam:PutRolePolicy",
]);

export function collectServiceActions(): {
  ccapiActions: string[];
  serviceActions: string[];
} {
  const allActions = new Set<string>();
  for (const resourceType of SUPPORTED_TYPES_ARRAY) {
    for (const action of getRequiredIamActions(resourceType)) {
      allActions.add(action);
    }
  }

  const ccapiActions: string[] = [];
  const serviceActionsRaw: string[] = [];
  for (const action of allActions) {
    if (action.startsWith("cloudcontrol:")) {
      ccapiActions.push(action);
    } else if (TAG_SCOPED_RDS_SNAPSHOT_ACTIONS.has(action)) {
      // Skip — emitted separately in operatorPolicy() with a
      // ResourceTag-scoped Condition (security MEDIUM from the
      // e2e expert review).
      continue;
    } else if (PRIV_ESC_SCOPED_IAM_ACTIONS.has(action)) {
      // Story 50-5 B-3: emitted separately in operatorPolicy() via
      // the IamRoleManagementAssigneeScoped statement with
      // `role/assignee-*` resource scope + iam:PassedToService
      // allowlist. Leaving them in the unscoped sweep would let
      // IAM union semantics bypass the scope.
      continue;
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
  return { ccapiActions, serviceActions };
}

/**
 * Partitions the fully-collected, sorted service-specific action list
 * into two byte-balanced halves (`a` and `b`) so each half can be
 * emitted as its own managed policy and still fit inside the AWS
 * 6144-byte limit.
 *
 * Algorithm (deterministic, stable, byte-balanced):
 *   1. Compute the total serialized byte count of the action array.
 *   2. Walk the sorted list accumulating byte cost (quoted + comma).
 *   3. Cut at the first index where the running total has crossed
 *      half of the grand total — putting the rest in `b`.
 *
 * Why cumulative bytes and not `splice(length / 2)`? Service actions
 * vary in length; a count-based midpoint would silently grow lopsided
 * as long-named services dominate one half. The byte-based cut keeps
 * both halves within a couple percent of each other.
 */
export function splitServiceActions(actions: readonly string[]): {
  a: string[];
  b: string[];
} {
  if (actions.length < 2) {
    return { a: [...actions], b: [] };
  }
  // Approximate JSON serialization cost per action: the action string
  // itself + two quotes + a comma. Off by a constant but the ratio is
  // preserved.
  const byteCost = (s: string): number => s.length + 3;
  const total = actions.reduce((sum, a) => sum + byteCost(a), 0);
  const halfTarget = total / 2;
  let running = 0;
  let cut = 0;
  for (let i = 0; i < actions.length; i++) {
    running += byteCost(actions[i]!);
    if (running >= halfTarget) {
      cut = i + 1;
      break;
    }
  }
  // Defensive: always leave at least one action in each half.
  if (cut === 0) cut = 1;
  if (cut >= actions.length) cut = actions.length - 1;
  return {
    a: actions.slice(0, cut),
    b: actions.slice(cut),
  };
}
